import { pathToFileURL } from "node:url";

const apiVersion = "2022-11-28";

export async function deleteRunReports({ repository, runId, attempt, token, fetchImpl = fetch }) {
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository ?? "")) throw new Error("Invalid repository");
  if (!/^\d+$/u.test(String(runId)) || !/^\d+$/u.test(String(attempt)))
    throw new Error("Invalid run identifier");
  if (!token) throw new Error("Missing token");
  const prefix = `report-${runId}-${attempt}-`;
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": apiVersion,
  };
  const base = `https://api.github.com/repos/${repository}/actions`;
  const deleted = [];
  for (let page = 1; ; page += 1) {
    const response = await fetchImpl(`${base}/runs/${runId}/artifacts?per_page=100&page=${page}`, {
      headers,
    });
    if (!response.ok) throw new Error(`Listing artifacts failed: ${response.status}`);
    const { artifacts } = await response.json();
    for (const artifact of artifacts) {
      if (!artifact.name.startsWith(prefix)) continue;
      const removal = await fetchImpl(`${base}/artifacts/${artifact.id}`, {
        method: "DELETE",
        headers,
      });
      if (!removal.ok && removal.status !== 404)
        throw new Error(`Deleting ${artifact.name} failed: ${removal.status}`);
      deleted.push(artifact.name);
    }
    if (artifacts.length < 100) return deleted;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const deleted = await deleteRunReports({
    repository: process.env.GITHUB_REPOSITORY,
    runId: process.env.GITHUB_RUN_ID,
    attempt: process.env.GITHUB_RUN_ATTEMPT,
    token: process.env.GITHUB_TOKEN,
  });
  console.log(`deleted ${deleted.length} report artifacts`);
}
