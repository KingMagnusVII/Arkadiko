const endpoint = document.querySelector("#endpoint");
const token = document.querySelector("#token");
const status = document.querySelector("#status");
const save = document.querySelector("#save");

async function restore() {
  const saved = await chrome.storage.local.get(["endpoint", "token"]);
  endpoint.value = saved.endpoint || "http://127.0.0.1:8765";
  token.value = saved.token || "";
  status.textContent = "Settings loaded.";
}
save.addEventListener("click", async () => {
  const url = endpoint.value.trim().replace(/\/$/, "");
  const secret = token.value.trim();
  if (!url || !secret) {
    status.textContent = "Enter both the API URL and Bridge token.";
    return;
  }
  await chrome.storage.local.set({ endpoint: url, token: secret });
  status.textContent = "Saved. Reload your ChatGPT tab if the extension was already open.";
});
restore();
