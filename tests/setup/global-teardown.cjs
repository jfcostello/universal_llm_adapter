module.exports = async () => {
  // Close logger to prevent open file handles
  const { closeLogger } = await import('../../dist/modules/logging/index.js');
  await closeLogger();
};
