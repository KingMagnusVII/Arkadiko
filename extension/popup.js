const endpointInput = document.querySelector("#endpoint");
const tokenInput = document.querySelector("#token");
const taskInput = document.querySelector("#task");
const status = document.querySelector("#status");

chrome.storage.local.get(["endpoint", "token"], (saved) => {
  if (saved.endpoint) endpointInput.value = saved.endpoint;
  if (saved.token) tokenInput.value = saved.token;
});

document.querySelector("#send").addEventListener("click", async () => {
  const endpoint = endpointInput.value.trim().replace(/\/$/, "");
  const token = tokenInput.value.trim();
  const task = taskInput.value.trim();
  if (!token || !task) {
    status.textContent = "Enter the bridge token and a task.";
    return;
  }

  await chrome.storage.local.set({ endpoint, token });
  status.textContent = "Submitting task...";
  try {
    const response = await fetch(`${endpoint}/v1/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify({ task })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.detail || response.statusText);
    status.textContent = `Accepted: ${payload.task_id}\nStatus: ${payload.status}`;
  } catch (error) {
    status.textContent = `Failed: ${error.message}`;
  }
});
