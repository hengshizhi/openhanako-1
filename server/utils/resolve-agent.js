/**
 * Resolve target agent from request context.
 * Priority: query.agentId > params.agentId > engine.currentAgentId
 * Falls back to focus agent for backward compatibility.
 */
export function resolveAgent(engine, c) {
  const agentId = c.req.query("agentId") || c.req.param("agentId") || engine.currentAgentId;
  return engine.getAgent(agentId) || engine.agent;
}
