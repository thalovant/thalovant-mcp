// Test-only, loaded with `node --import` before the server: makes the process
// answer the platform a browser-login vector case names (`darwin`, `win32`,
// `linux`, ...), so the SDK's browser rule and the server's opener read the
// case's machine. Nothing the package ships loads it.
const platform = process.env.THALOVANT_TEST_PLATFORM;
if (platform) {
  Object.defineProperty(process, "platform", { ...Object.getOwnPropertyDescriptor(process, "platform"), value: platform });
}
