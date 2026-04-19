export function log(message) {
  const timestamp = new Date().toLocaleString("zh-CN", {
    hour12: false
  });
  console.log(`[${timestamp}] ${message}`);
}
