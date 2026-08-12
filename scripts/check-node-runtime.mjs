const minimumNodeVersion = [22, 13, 0];
const minimumNodeVersionLabel = "22.13.0";
const supportedNodeMajor = 22;
const maximumNodeVersionLabel = "23";
const nodeVersionRequirementLabel = `>=${minimumNodeVersionLabel} and <${maximumNodeVersionLabel}`;

try {
  const { ensureWritableTmpDir } = await import("./ensure-writable-tmpdir.mjs");
  ensureWritableTmpDir();
} catch {
  // Best-effort: older/broken temp mounts shouldn't block the version check.
}

function parseNodeVersion(version) {
  return version
    .replace(/^v/, "")
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
}

function partAt(versionParts, index) {
  // Avoid `??` so very old Node can at least print a clear version error.
  const value = versionParts[index];
  return value === undefined || value === null ? 0 : value;
}

function isAtLeastMinimum(version) {
  const current = parseNodeVersion(version);
  for (let index = 0; index < minimumNodeVersion.length; index += 1) {
    if (partAt(current, index) > minimumNodeVersion[index]) return true;
    if (partAt(current, index) < minimumNodeVersion[index]) return false;
  }
  return true;
}

function isSupportedMajor(version) {
  return partAt(parseNodeVersion(version), 0) === supportedNodeMajor;
}

function formatNodeVersion(version) {
  return version.startsWith("v") ? version : `v${version}`;
}

function fail(message) {
  console.error(`[pilotdeck] ${message}`);
  process.exit(1);
}

const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, typeOrOptions, ...args) => {
  const warningType =
    typeof typeOrOptions === "string"
      ? typeOrOptions
      : typeOrOptions && typeOrOptions.type;
  const warningText =
    typeof warning === "string"
      ? warning
      : warning && warning.message;
  if (
    warningType === "ExperimentalWarning" &&
    typeof warningText === "string" &&
    warningText.includes("SQLite")
  ) {
    return;
  }
  emitWarning(warning, typeOrOptions, ...args);
};

const testMode = process.env.PILOTDECK_RUNTIME_CHECK_TEST_MODE === "1";
const nodeVersion =
  testMode && process.env.PILOTDECK_TEST_NODE_VERSION
    ? process.env.PILOTDECK_TEST_NODE_VERSION
    : process.versions.node;
const skipSqliteCheck = testMode && process.env.PILOTDECK_TEST_SKIP_SQLITE === "1";

if (!isAtLeastMinimum(nodeVersion) || !isSupportedMajor(nodeVersion)) {
  fail(
    `Node.js ${nodeVersionRequirementLabel} is required because PilotDeck uses node:sqlite and native packages are built for Node.js ${supportedNodeMajor}. Current: ${formatNodeVersion(nodeVersion)}. Switch to Node.js ${supportedNodeMajor} and reinstall dependencies.`,
  );
}

if (!skipSqliteCheck) {
  try {
    await import("node:sqlite");
  } catch {
    fail(
      `Current Node.js (${formatNodeVersion(nodeVersion)}) does not provide node:sqlite. Switch to Node.js ${minimumNodeVersionLabel}+ and reinstall dependencies.`,
    );
  }
}
