import { Hono } from "hono";
import fs from "fs";
import path from "path";
import os from "os";
import { extractZip } from "../../lib/extract-zip.js";

/**
 * 代理分发：将 /plugins/:pluginId/* 的请求转发到对应 plugin 子 app。
 * @param {import("hono").Context} c
 * @param {import("hono").Hono} pluginApp
 * @param {string} pluginId
 */
async function proxyToPlugin(c, pluginApp, pluginId) {
  const url = new URL(c.req.url);
  const prefix = `/plugins/${pluginId}`;
  const prefixIndex = url.pathname.indexOf(prefix);
  const subPath = prefixIndex !== -1
    ? url.pathname.slice(prefixIndex + prefix.length) || "/"
    : "/";
  url.pathname = subPath;

  const subReq = new Request(url.toString(), {
    method: c.req.method,
    headers: c.req.raw.headers,
    body: c.req.method !== "GET" && c.req.method !== "HEAD"
      ? c.req.raw.body
      : undefined,
  });
  return pluginApp.fetch(subReq);
}

/**
 * Standalone route proxy (for tests).
 * @param {Map<string, import("hono").Hono>} routeRegistry
 */
export function createPluginProxyRoute(routeRegistry) {
  const route = new Hono();
  route.all("/plugins/:pluginId/*", async (c) => {
    const pluginId = c.req.param("pluginId");
    const pluginApp = routeRegistry.get(pluginId);
    if (!pluginApp) return c.json({ error: `Plugin "${pluginId}" not found` }, 404);
    return proxyToPlugin(c, pluginApp, pluginId);
  });
  return route;
}

/**
 * Plugin management REST API + route proxy (combined).
 * @param {import('../../core/engine.js').HanaEngine} engine
 */
export function createPluginsRoute(engine) {
  const route = new Hono();

  // ── Management API (specific routes first) ──

  route.get("/plugins", (c) => {
    const pm = engine.pluginManager;
    if (!pm) return c.json([]);
    const source = c.req.query("source"); // ?source=community 或 ?source=builtin
    let plugins = pm.listPlugins();
    if (source) plugins = plugins.filter(p => p.source === source);
    return c.json(plugins.map(p => ({
      id: p.id, name: p.name, version: p.version,
      description: p.description, status: p.status,
      source: p.source || "community", trust: p.trust || "restricted",
      contributions: p.contributions,
      error: p.error || null,
    })));
  });

  route.get("/plugins/config-schemas", (c) => {
    const pm = engine.pluginManager;
    return c.json(pm?.getAllConfigSchemas() || []);
  });

  route.get("/plugins/:id/config-schema", (c) => {
    const pm = engine.pluginManager;
    const schema = pm?.getConfigSchema(c.req.param("id"));
    if (!schema) return c.json({ error: "not found" }, 404);
    return c.json(schema);
  });

  // ── Plugin install ──
  route.post("/plugins/install", async (c) => {
    const pm = engine.pluginManager;
    if (!pm) return c.json({ error: "Plugin manager not available" }, 500);
    const { path: sourcePath } = await c.req.json();
    if (!sourcePath) return c.json({ error: "path is required" }, 400);

    try {
      const stat = fs.statSync(sourcePath);
      let targetDir;
      const userPluginsDir = pm._pluginsDirs[pm._pluginsDirs.length - 1];
      // Ensure plugins directory exists
      fs.mkdirSync(userPluginsDir, { recursive: true });

      if (sourcePath.endsWith(".zip")) {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-install-"));
        extractZip(sourcePath, tmpDir);
        const entries = fs.readdirSync(tmpDir, { withFileTypes: true });
        const pluginSrc = entries.length === 1 && entries[0].isDirectory()
          ? path.join(tmpDir, entries[0].name)
          : tmpDir;
        const dirName = path.basename(pluginSrc);
        targetDir = path.join(userPluginsDir, dirName);
        // Atomic install: copy to temp target, then rename
        const tmpTarget = targetDir + ".installing";
        if (fs.existsSync(tmpTarget)) fs.rmSync(tmpTarget, { recursive: true });
        fs.cpSync(pluginSrc, tmpTarget, { recursive: true });
        if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true });
        fs.renameSync(tmpTarget, targetDir);
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } else if (stat.isDirectory()) {
        const dirName = path.basename(sourcePath);
        targetDir = path.join(userPluginsDir, dirName);
        const tmpTarget = targetDir + ".installing";
        if (fs.existsSync(tmpTarget)) fs.rmSync(tmpTarget, { recursive: true });
        fs.cpSync(sourcePath, tmpTarget, { recursive: true });
        if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true });
        fs.renameSync(tmpTarget, targetDir);
      } else {
        return c.json({ error: "Path must be a .zip file or directory" }, 400);
      }

      if (!pm._isValidPluginDir(targetDir)) {
        fs.rmSync(targetDir, { recursive: true, force: true });
        return c.json({ error: "Not a valid plugin directory" }, 400);
      }

      const entry = await pm.installPlugin(targetDir);
      return c.json(entry);
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // ── Plugin delete ──
  route.delete("/plugins/:id", async (c) => {
    const pm = engine.pluginManager;
    if (!pm) return c.json({ error: "Plugin manager not available" }, 500);
    const id = c.req.param("id");
    try {
      const pluginDir = await pm.removePlugin(id);
      if (pluginDir && fs.existsSync(pluginDir)) {
        fs.rmSync(pluginDir, { recursive: true, force: true });
      }
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message }, 404);
    }
  });

  // ── Plugin enable/disable ──
  route.put("/plugins/:id/enabled", async (c) => {
    const pm = engine.pluginManager;
    if (!pm) return c.json({ error: "Plugin manager not available" }, 500);
    const id = c.req.param("id");
    const { enabled } = await c.req.json();
    try {
      if (enabled) {
        await pm.enablePlugin(id);
      } else {
        await pm.disablePlugin(id);
      }
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message }, 404);
    }
  });

  // ── Global plugin settings ──
  route.get("/plugins/settings", (c) => {
    const pm = engine.pluginManager;
    const userDir = pm?._pluginsDirs?.[pm._pluginsDirs.length - 1] || "";
    return c.json({
      allow_full_access: pm?._preferencesManager?.getAllowFullAccessPlugins() || false,
      plugins_dir: userDir,
    });
  });

  route.put("/plugins/settings", async (c) => {
    const pm = engine.pluginManager;
    if (!pm) return c.json({ error: "Plugin manager not available" }, 500);
    const { allow_full_access } = await c.req.json();
    if (typeof allow_full_access === "boolean") {
      await pm.setFullAccess(allow_full_access);
    }
    const plugins = pm.listPlugins();
    return c.json(plugins.map(p => ({
      id: p.id, name: p.name, version: p.version,
      description: p.description, status: p.status,
      source: p.source || "community", trust: p.trust || "restricted",
      contributions: p.contributions, error: p.error || null,
    })));
  });

  // ── Plugin route proxy (catch-all last) ──

  route.all("/plugins/:pluginId/*", async (c) => {
    const pluginId = c.req.param("pluginId");
    const pluginApp = engine.pluginManager?.routeRegistry.get(pluginId);
    if (!pluginApp) return c.json({ error: `Plugin "${pluginId}" not found` }, 404);
    return proxyToPlugin(c, pluginApp, pluginId);
  });

  return route;
}
