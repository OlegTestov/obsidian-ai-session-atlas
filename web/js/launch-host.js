// Wait for the matching Obsidian launch result before assigning a session to a workspace.
/* exported requestHostLaunch -- used by catalog and workspace launches */
function requestHostLaunch(type, data, request) {
  if (!EMBEDDED) return Promise.resolve(null);
  return new Promise(resolve => {
    const finish = result => {
      window.removeEventListener("message", reply);
      window.clearTimeout(timer);
      resolve(result);
    };
    const reply = event => {
      const result = event.data;
      if (event.source === window.parent && result?.source === HOST_SOURCE
          && result.type === "launch-result" && result.request === request) finish(result);
    };
    const timer = window.setTimeout(() => finish(null), 17000);
    window.addEventListener("message", reply);
    tellHost(type, { ...data, launchRequest:request });
  });
}
