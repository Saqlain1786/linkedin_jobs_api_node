// Filtering logic (improved)
const applyFilters = (jobs, params) => {
  const { requireRemote, requireContract } = params;

  return jobs.filter(j => {
    const desc = (j.descriptionSnippet || "").toLowerCase();
    const title = (j.position || "").toLowerCase();

    let ok = true;

    // Remote filter (match multiple variations)
    if (requireRemote) {
      const remoteTokens = [
        "remote", "wfh", "work from home", "telecommute",
        "distributed", "home based", "virtual"
      ];
      ok = remoteTokens.some(t => desc.includes(t) || title.includes(t));
      if (!ok) return false;
    }

    // Contract filter (match common contract terms)
    if (requireContract) {
      const contractTokens = [
        "contract", "temp", "temporary", "6 month",
        "12 month", "freelance", "fixed-term", "w2"
      ];
      ok = contractTokens.some(t => desc.includes(t) || title.includes(t));
      if (!ok) return false;
    }

    return ok;
  });
};
