module.exports = async () => {
  // Close logger to prevent open file handles
  const { closeLogger } = await import('../../dist/core/logging.js');
  await closeLogger();
};
