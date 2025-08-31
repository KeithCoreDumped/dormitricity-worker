export async function dispatchWorkflow(env: any, inputs: any) {
  const url = `https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}/actions/workflows/${env.GH_WORKFLOW}/dispatches`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.GITHUB_PAT}`,
      "Accept": "application/vnd.github+json",
      "User-Agent": "Dormitricity-Worker" // required by Github API
    },
    body: JSON.stringify({ ref: env.GH_REF || "main", inputs })
  });
  if (!res.ok) throw new Error(`dispatch failed: ${res.status} ${await res.text()}`);
}
