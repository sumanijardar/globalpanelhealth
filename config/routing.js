// Alert routing cache is not required for GlobalPanelHealth (health check only)
module.exports = {
  panelConfigCache: new Map(),
  refreshCache: async () => {}
};
