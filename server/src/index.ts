/**
 * Public API of the mcmcp bridge. The CLI and the MCP server are both thin
 * layers over these exports, so anything they can do is scriptable.
 */

export {
  DEFAULT_HOST,
  DEFAULT_PORT,
  addressOf,
  clientsDir,
  configDir,
  configPath,
  defaultConfig,
  defaultTokenPath,
  ensureConfigDir,
  ensureToken,
  loadConfig,
  readDescriptors,
  resolveClient,
  resolveToken,
  saveConfig,
  startHint,
  tokenPermissions,
  type McmcpConfig,
  type ResolveOptions,
  type ResolvedClient,
} from './config.js';

export {
  McmcpError,
  ModClient,
  type ClientOptions,
  type HealthInfo,
  type JsonRpcError,
  type JsonRpcRequest,
  type McEvent,
  type MethodParam,
  type MethodSpec,
  type RuntimeDescriptor,
} from './protocol.js';

export {
  discoverRoots,
  findBuiltJar,
  findInstance,
  findModJars,
  installMod,
  listInstances,
  parseInstanceCfg,
  parseMmcPack,
  parseModVersion,
  readInstanceLog,
  uninstallMod,
  type InstallOutcome,
  type Instance,
  type InstanceRoot,
  type LauncherKind,
  type LoaderKind,
  type UninstallOutcome,
} from './instances.js';

export { launchInstance, type LaunchOptions, type LaunchResult } from './launcher.js';

export {
  detectShape,
  defaultGlobalDir,
  parseJsonc,
  resolveConfigPath,
  setup as setupOpencode,
  status as opencodeStatus,
  type OpencodeShape,
  type OpencodeStatus,
  type SetupOptions,
  type SetupResult,
} from './opencode.js';

export { runDoctor, type Check, type CheckStatus, type DoctorReport } from './doctor.js';

export {
  INSTRUCTIONS,
  SERVER_NAME,
  VERSION,
  createServer,
  serveStdio,
} from './mcp.js';

export {
  TOOL_DEFS,
  getClient,
  registerTools,
  resetClientCache,
  toolError,
  toolNames,
  toolSummary,
  toolSuccess,
  type ToolArgs,
  type ToolDef,
} from './tools.js';
