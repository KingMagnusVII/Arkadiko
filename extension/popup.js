const endpointInput = document.querySelector("#endpoint");
const tokenInput = document.querySelector("#token");
const taskInput = document.querySelector("#task");
const status = document.querySelector("#status");
const resultBox = document.querySelector("#result");
const checkButton = document.querySelector("#check");
const copyButton = document.querySelector("#copy");
let latestTaskId = null;
let latestReport = "";

chrome.storage.local.get(["endpoint", "token"], (saved) => {
  if (saved.endpoint) endpointInput.value = saved.endpoint;
  if (saved.token) tokenInput.value = saved.token;
});

function authHeaders() {
  const token = tokenInput.value.trim();
  if (!token) throw new Error("Enter the bridge token.");
  return { "Content-Type": "application/json", "Authorization": `Bearer ${token}` };
}

function renderReport(data) {
  latestReport = [
    `Task ID: ${data.task_id}`,
    `Status: ${data.status}`,
    `Exit code: ${data.exit_code ?? "not available"}`,
    data.error ? `Error: ${data.error}` : "",
    "STDOUT:",
    data.stdout || "(empty)",
    "STDERR:",
    data.stderr || "(empty)"
  ].filter(Boolean).join("\n");
  resultBox.textContent = latestReport;
  resultBox.hidden = false;
  copyButton.hidden = false;
}

document.querySelector("#send").addEventListener("click", async () => {
  const endpoint = endpointInput.value.trim().replace(/\/$/, "");
  const task = taskInput.value.trim();
  if (!task) { status.textContent = "Enter a task."; return; }
  status.textContent = "Submitting task...";
  resultBox.hidden = true;
  copyButton.hidden = true;
  try {
    await chrome.storage.local.set({ endpoint, token: tokenInput.value.trim() });
    const response = await fetch(`${endpoint}/v1/tasks`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ task })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.detail || response.statusText);
    latestTaskId = payload.task_id;
    checkButton.disabled = false;
    status.textContent = `Accepted: ${latestTaskId}\nStatus: ${payload.status}. Use "Check latest result" when it finishes.`;
  } catch (error) {
    status.textContent = `Failed: ${error.message}`;
  }
});

checkButton.addEventListener("click", async () => {
  if (!latestTaskId) return;
  const endpoint = endpointInput.value.trim().replace(/\/$/, "");
  status.textContent = "Checking task...";
  try {
    const response = await fetch(`${endpoint}/v1/tasks/${encodeURIComponent(latestTaskId)}`, {
      headers: authHeaders()
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || response.statusText);
    status.textContent = `Task ${data.task_id}: ${data.status}`;
    if (["completed", "failed"].includes(data.status)) renderReport(data);
  } catch (error) {
    status.textContent = `Failed: ${error.message}`;
  }
});

copyButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(latestReport);
    status.textContent = "Report copied. Paste it into your ChatGPT conversation.";
  } catch (error) {
    status.textContent = `Could not copy report: ${error.message}`;
  }
});
