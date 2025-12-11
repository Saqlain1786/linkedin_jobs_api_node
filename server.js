// server.js
// Lightweight LinkedIn job wrapper — NO Selenium, NO RapidAPI.
// Usage: GET /search?keyword=service%20desk&location=United%20States&days=30&limit=100&start=0&require_remote=true&require_contract=false&fetch_details=false

import express from "express";
import axios from "axios";
import qs from "querystring";
import cheerio from "cheerio";

const app = express();
const PORT = process.env.PORT || 5000;

// Tuning lists
const TITLE_KEYWORDS = [
  "service desk","help desk","helpdesk","desktop support","technical support",
  "support specialist","service desk technician","help desk technician",
  "msp","managed service","it support","it technician","field technician",
  "support engineer","support analyst","desk engineer","support tech"
].map(s => s.toLowerCase());

const REMOTE_TOKENS = ["remote","work from home","wfh","distributed","telecommute","work-from-home"].map(s=>s.toLowerCase());
const CONTRACT_TOKENS = ["contract","contractor","temp","temporary","freelance","fixed-term","fixed term","6 month","12 month","6-month","12-month","contract role","on contract"].map(s=>s.toLowerCase());

// helpers
const toInt = (v, d) => { const n = parseInt(v,10); return Number.isFinite(n) ? n : d; };
const containsAny = (hay, tokens) => { if(!hay) return false; const s=String(hay).toLowerCase(); for(const t of tokens) if(s.includes(t)) return true; return false; };
const extractJobId = url => {
  if(!url) return "";
  const m = url.match(/\/jobs\/view\/([0-9]+)/) || url.match(/[?&]currentJobId=([0-9]+)/);
  return m ? (m[1]||m[2]) : "";
};
const normalize = raw => ({
  position: (raw.position || raw.title || raw.jobTitle || "").trim(),
  company: (raw.company || raw.companyName || raw.subtitle || "").trim(),
  location: (raw.location || raw.region || raw.jobLocation || "").trim(),
  date: (raw.date || raw.postedAt || raw.posted || "").trim(),
  salary: (raw.salary || raw.compensation || "Not specified").trim(),
  jobUrl: (raw.jobUrl || raw.applyUrl || raw.url || "").trim(),
  companyLogo: (raw.companyLogo || raw.logo || "").trim(),
  description: (raw.description || raw.snippet || "").trim()
});

// fallback HTML parser (cheerio) for LinkedIn job result cards
function parseLinkedInHtml(html) {
  const $ = cheerio.load(html || "");
  const items = [];
  // LinkedIn job card selectors (best-effort)
  const cardSelectors = ['.base-card', '.jobs-search-results__list-item', '.job-card-container', 'li.job-result-card'];
  let nodes = [];
  for (const cs of cardSelectors) {
    const found = $(cs).toArray();
    if (found.length) { nodes = found; break; }
  }
  if (!nodes.length) {
    nodes = $('a[href*="/jobs/view"]').closest('li, div').toArray();
  }

  for (const node of nodes) {
    const el = $(node);
    const position = el.find('.base-search-card__title, .job-card-list__title, .result-card__title, .job-card-list__title').first().text().trim() || el.find('a').first().text().trim();
    const company = el.find('.base-search-card__subtitle, .result-card__subtitle, .job-card-container__company-name, .job-result-card__subtitle').first().text().trim();
    const location = el.find('.job-search-card__location, .job-card-container__metadata-item, .result-card__meta, .job-result-card__location').first().text().trim();
    let jobUrl = el.find('a.base-card__full-link, a.result-card__full-card-link, a.job-card-list__title-link, a').first().attr('href') || '';
    if (jobUrl && jobUrl.startsWith('/')) jobUrl = `https://www.linkedin.com${jobUrl}`;
    items.push({ position, company, location, jobUrl, description: '' });
  }
  return items;
}

// Optional fetch details (sequential, safe)
async function fetchJobDetailIfNeeded(jobs, timeoutPer = 8000) {
  const out = [];
  for (const j of jobs) {
    let desc = j.description || '';
    let companyUrl = '';
    if (j.jobUrl) {
      try {
        const resp = await axios.get(j.jobUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
          timeout: timeoutPer
        });
        const $ = cheerio.load(String(resp.data || ''));
        const selectors = ['.description__text','.show-more-less-html__markup','.job-description__content','.description'];
        for (const s of selectors) {
          const t = $(s).first().text().trim();
          if (t) { desc = desc || t; break; }
        }
        const cLink = $('a[href*="/company/"]').first().attr('href') || '';
        if (cLink) companyUrl = cLink.startsWith('http') ? cLink : `https://www.linkedin.com${cLink}`;
      } catch (e) {
        // ignore per-job errors
      }
    }
    out.push(Object.assign({}, j, { description: desc, companyUrl }));
  }
  return out;
}

app.get('/search', async (req, res) => {
  try {
    const rq = req.query || {};
    const opts = {
      keyword: (rq.keyword || rq.keywords || rq.q || 'service desk').toString().trim(),
      location: (rq.location || rq.loc || 'United States').toString().trim(),
      days: toInt(rq.days, 30),
      limit: Math.min(Math.max(toInt(rq.limit, 100),1),200),
      start: Math.max(toInt(rq.start, 0), 0),
      requireRemote: String(rq.require_remote || rq.requireRemote || 'false').toLowerCase() === 'true',
      requireContract: String(rq.require_contract || rq.requireContract || 'false').toLowerCase() === 'true',
      fetchDetails: String(rq.fetch_details || 'false').toLowerCase() === 'true'
    };

    // Build LinkedIn guest feed URL (works without auth)
    const upstreamBase = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';
    const upstreamParams = {
      location: opts.location,
      keywords: opts.keyword,
      start: opts.start,
      count: opts.limit,
      limit: opts.limit,
      f_TPR: `r${opts.days}`,
      _: Date.now()
    };
    if (opts.requireRemote) {
      upstreamParams.f_JT = 'R'; // try remote param (may or may not filter upstream)
    }

    const upstreamUrl = `${upstreamBase}?${qs.stringify(upstreamParams)}`;

    // Fetch upstream
    let upstreamResp;
    try {
      upstreamResp = await axios.get(upstreamUrl, {
        headers: {
          'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Accept': 'application/json, text/html, */*'
        },
        timeout: 20000
      });
    } catch (err) {
      if (err && err.response && err.response.data) {
        upstreamResp = err.response;
      } else {
        return res.status(502).json({ error: 'Upstream request failed', detail: err && err.message });
      }
    }

    // Parse response shapes
    let rawJobs = [];
    try {
      const body = upstreamResp && upstreamResp.data;
      if (Array.isArray(body)) rawJobs = body;
      else if (body && typeof body === 'object') {
        if (Array.isArray(body.elements)) rawJobs = body.elements;
        else if (Array.isArray(body.jobs)) rawJobs = body.jobs;
        else if (Array.isArray(body.data)) rawJobs = body.data;
        else {
          const s = JSON.stringify(body);
          if (s && s.trim().startsWith('<')) rawJobs = parseLinkedInHtml(s);
          else rawJobs = [];
        }
      } else if (typeof body === 'string') {
        rawJobs = parseLinkedInHtml(body);
      } else rawJobs = [];
    } catch (e) {
      const s = upstreamResp && upstreamResp.data ? String(upstreamResp.data) : '';
      rawJobs = s ? parseLinkedInHtml(s) : [];
    }

    // Normalize
    let normalized = rawJobs.map(normalize);

    // Optionally fetch job details
    if (opts.fetchDetails && normalized.length) {
      normalized = await fetchJobDetailIfNeeded(normalized, 8000);
    }

    // Filters: title/company must match keywords
    normalized = normalized.filter(j => {
      const hay = `${(j.position||'')} ${(j.company||'')} ${(j.description||'')}`.toLowerCase();
      return TITLE_KEYWORDS.some(k => hay.includes(k));
    });

    if (opts.requireRemote) {
      normalized = normalized.filter(j => {
        const hay = `${j.location} ${j.position} ${j.company} ${j.description} ${j.jobUrl}`.toLowerCase();
        return containsAny(hay, REMOTE_TOKENS);
      });
    }

    if (opts.requireContract) {
      normalized = normalized.filter(j => {
        const hay = `${j.position} ${j.company} ${j.description} ${j.jobUrl}`.toLowerCase();
        return containsAny(hay, CONTRACT_TOKENS);
      });
    }

    // Dedupe
    const seen = new Set();
    const dedup = [];
    for (const j of normalized) {
      const id = extractJobId(j.jobUrl) || `${j.position}|${j.company}|${j.location}`;
      if (!seen.has(id)) { seen.add(id); j.jobId = id; dedup.push(j); }
    }

    const resultJobs = dedup.slice(0, opts.limit).map(j => ({
      jobId: j.jobId,
      position: j.position,
      company: j.company,
      location: j.location,
      date: j.date,
      salary: j.salary,
      jobUrl: j.jobUrl,
      companyUrl: j.companyUrl || '',
      companyLogo: j.companyLogo || '',
      descriptionSnippet: (j.description || '').slice(0,800),
      isRemote: containsAny(`${j.location} ${j.position} ${j.company} ${j.description}`, REMOTE_TOKENS),
      isContract: containsAny(`${j.position} ${j.company} ${j.description}`, CONTRACT_TOKENS)
    }));

    return res.json({
      totalFetched: rawJobs.length,
      totalMatchedAfterFilters: dedup.length,
      returned: resultJobs.length,
      paramsUsed: opts,
      jobs: resultJobs
    });

  } catch (err) {
    console.error('Search handler error', err && (err.stack || err));
    return res.status(500).json({ error: 'Internal server error', detail: err && err.message });
  }
});

app.listen(PORT, () => {
  console.log(`LinkedIn jobs wrapper listening on ${PORT} — ENV PORT=${PORT}`);
});
