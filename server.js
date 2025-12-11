// server.js
// LinkedIn job wrapper tailored for: service desk / help desk / MSP
// Filters for remote and contract roles; supports HTML (cheerio) fallback and optional job-detail fetch.
// Usage example:
// GET /search?keyword=service%20desk&location=United%20States&days=7&limit=100&start=0&require_remote=true&require_contract=true&fetch_details=false

import express from 'express';
import axios from 'axios';
import { load } from 'cheerio';

const app = express();
const PORT = process.env.PORT || 3000;

// --- Configuration: tuning lists
const TITLE_KEYWORDS = [
  'service desk','help desk','helpdesk','desktop support','technical support',
  'support specialist','service desk technician','help desk technician',
  'msp','managed service','it support','it technician','field technician',
  'support engineer','support analyst','desk engineer','support tech'
].map(s => s.toLowerCase());

const REMOTE_TOKENS = [
  'remote', 'work from home', 'wfh', 'distributed', 'telecommute', 'work-from-home'
].map(s => s.toLowerCase());

const CONTRACT_TOKENS = [
  'contract', 'contractor', 'temp', 'temporary', 'freelance', 'fixed-term', 'fixed term',
  '6 month','12 month','6-month','12-month','contract role','on contract'
].map(s => s.toLowerCase());

// --- Utilities
function toIntSafe(v, fallback = 0) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}
function normalizeLocation(loc) {
  if (!loc) return '';
  let s = String(loc).trim();
  s = s.replace(/\bUS\b/gi, 'United States').replace(/[,\s]+/g, ' ').trim();
  s = Array.from(new Set(s.split(/\s+/))).join(' ');
  return s;
}
function extractJobId(url = '') {
  if (!url) return '';
  const m = url.match(/\/jobs\/view\/([0-9]+)/) || url.match(/[?&]currentJobId=([0-9]+)/);
  return m ? m[1] : '';
}
function joinText(...arr) {
  return arr.filter(Boolean).join(' ').replace(/\s+/g,' ').trim().toLowerCase();
}
function containsAny(hay, tokens) {
  if (!hay) return false;
  const s = String(hay).toLowerCase();
  for (const t of tokens) if (s.includes(t)) return true;
  return false;
}

// Normalize raw job object
function normalizeJob(raw) {
  return {
    position: (raw.position || raw.title || raw.jobTitle || '').trim(),
    company: (raw.company || raw.companyName || raw.subtitle || '').trim(),
    location: (raw.location || raw.region || raw.jobLocation || '').trim(),
    date: (raw.date || raw.postedAt || raw.posted || '').trim(),
    salary: (raw.salary || raw.compensation || 'Not specified').trim(),
    jobUrl: (raw.jobUrl || raw.applyUrl || raw.url || '').trim(),
    companyLogo: (raw.companyLogo || raw.logo || '').trim(),
    description: (raw.description || raw.snippet || '').trim()
  };
}

// Cheerio HTML parser for LinkedIn-style job cards (best-effort)
function parseLinkedInHtml(html) {
  const $ = load(html || '');
  const items = [];

  const cardSelectors = ['.base-card', 'li.job-result-card', '.result-card', '.jobs-search-results__list-item', '.job-card-container'];
  let nodes = [];
  for (const cs of cardSelectors) {
    const found = $(cs).toArray();
    if (found.length) { nodes = found; break; }
  }
  if (!nodes.length) {
    // fallback: try to locate links that look like job links
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

// Optional: fetch job detail page to extract snippet/description (sequential, bounded)
async function fetchJobDetailIfNeeded(jobs, timeoutPer = 10000) {
  const out = [];
  for (const j of jobs) {
    let desc = j.description || '';
    let companyUrl = '';
    if (j.jobUrl) {
      try {
        const resp = await axios.get(j.jobUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
          },
          timeout: timeoutPer
        });
        const body = String(resp.data || '');
        const $ = load(body);
        // job description selectors
        const descSel = ['.description__text', '.show-more-less-html__markup', '.job-description__content', '.description'];
        for (const sel of descSel) {
          const t = $(sel).first().text().trim();
          if (t) { desc = desc || t; break; }
        }
        const cLink = $('a[href*="/company/"]').first().attr('href') || $('a[href*="linkedin.com/company/"]').first().attr('href') || '';
        if (cLink) companyUrl = cLink.startsWith('http') ? cLink : `https://www.linkedin.com${cLink}`;
      } catch (err) {
        // ignore per-job errors to avoid failing whole request
      }
    }
    out.push(Object.assign({}, j, { description: desc, companyUrl }));
  }
  return out;
}

// --- /search handler ---
app.get('/search', async (req, res) => {
  try {
    const rq = req.query || {};
    const opts = {
      keyword: (rq.keyword || rq.keywords || rq.q || 'service desk').toString().trim(),
      location: normalizeLocation(rq.location || rq.loc || 'United States'),
      days: toIntSafe(rq.days, 7),
      limit: Math.min(Math.max(toIntSafe(rq.limit, 100), 1), 200), // default to 100
      start: Math.max(toIntSafe(rq.start, 0), 0),
      requireRemote: String(rq.require_remote || rq.requireRemote || 'false').toLowerCase() === 'true',
      requireContract: String(rq.require_contract || rq.requireContract || 'false').toLowerCase() === 'true',
      fetchDetails: String(rq.fetch_details || 'false').toLowerCase() === 'true'
    };

    console.log('Search request - opts:', opts);

    // Build upstream params
    const upstreamBase = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';
    const upstreamParams = {
      location: opts.location,
      keywords: opts.keyword,
      start: opts.start,
      count: opts.limit,
      limit: opts.limit,
      f_TPR: `r${opts.days}`,
      _: String(Date.now())
    };
    if (opts.requireRemote) {
      upstreamParams.f_JT = 'R';
    }
    const upstreamQuery = new URLSearchParams(upstreamParams).toString();
    const upstreamUrl = `${upstreamBase}?${upstreamQuery}`;
    console.log('Upstream URL ->', upstreamUrl, `(start=${upstreamParams.start} count=${upstreamParams.count})`);

    // Request upstream
    let upstreamResp;
    try {
      upstreamResp = await axios.get(upstreamUrl, {
        headers: {
          'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Accept': 'application/json, text/html, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache'
        },
        timeout: 20000
      });
    } catch (err) {
      if (err && err.response && err.response.data) {
        upstreamResp = err.response;
      } else {
        console.error('Upstream request failed', err && err.message);
        return res.status(502).json({ error: 'Upstream request failed', detail: err && err.message });
      }
    }

    // Parse response
    let rawJobs = [];
    try {
      const body = upstreamResp && upstreamResp.data;
      if (Array.isArray(body)) {
        rawJobs = body;
      } else if (body && typeof body === 'object') {
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
      } else {
        rawJobs = [];
      }
    } catch (err) {
      console.warn('Response parse problem; falling back to HTML parse', err && err.message);
      const s = upstreamResp && upstreamResp.data ? String(upstreamResp.data) : '';
      rawJobs = s ? parseLinkedInHtml(s) : [];
    }

    console.log(`Parsed raw jobs count: ${rawJobs.length}`);

    // Normalize
    let normalized = rawJobs.map(normalizeJob);

    // Optionally fetch details
    if (opts.fetchDetails && normalized.length) {
      console.log('fetchDetails=true -> fetching job detail pages sequentially (may be slow)');
      normalized = await fetchJobDetailIfNeeded(normalized, 10000);
      console.log('Job detail fetch complete');
    }

    const beforeFilter = normalized.length;

    // Filter by title/company keywords
    normalized = normalized.filter(j => {
      const hay = joinText(j.position, j.company, j.description);
      return TITLE_KEYWORDS.some(k => hay.includes(k));
    });

    // Remote filter
    if (opts.requireRemote) {
      normalized = normalized.filter(j => {
        const hay = joinText(j.location, j.position, j.company, j.description, j.jobUrl);
        return containsAny(hay, REMOTE_TOKENS);
      });
    }

    // Contract filter
    if (opts.requireContract) {
      normalized = normalized.filter(j => {
        const hay = joinText(j.position, j.company, j.description, j.jobUrl);
        return containsAny(hay, CONTRACT_TOKENS);
      });
    }

    console.log(`Filtered jobs: before=${beforeFilter} after=${normalized.length} (remote=${opts.requireRemote} contract=${opts.requireContract})`);

    // Deduplicate
    const seen = new Set();
    const deduped = [];
    for (const j of normalized) {
      const jobId = extractJobId(j.jobUrl);
      let key = '';
      if (jobId) key = `id:${jobId}`;
      else if (j.jobUrl) key = `url:${j.jobUrl}`;
      else key = `pc:${(j.position||'')+'|'+(j.company||'')}`;

      if (!seen.has(key)) {
        seen.add(key);
        if (j.jobUrl && j.jobUrl.startsWith('/')) j.jobUrl = `https://www.linkedin.com${j.jobUrl}`;
        const hay = joinText(j.location, j.position, j.company, j.description, j.jobUrl);
        j.isRemote = containsAny(hay, REMOTE_TOKENS);
        j.isContract = containsAny(hay, CONTRACT_TOKENS);
        j.jobId = jobId || key;
        if (!j.companyUrl) j.companyUrl = j.companyUrl || '';
        deduped.push(j);
      }
    }

    // Final output slice
    const outputJobs = deduped.slice(0, opts.limit);

    const output = {
      totalFetched: rawJobs.length,
      totalMatchedAfterFilters: deduped.length,
      returned: outputJobs.length,
      paramsUsed: opts,
      jobs: outputJobs.map(j => ({
        jobId: j.jobId,
        position: j.position,
        company: j.company,
        location: j.location,
        date: j.date,
        salary: j.salary,
        jobUrl: j.jobUrl,
        companyUrl: j.companyUrl || '',
        companyLogo: j.companyLogo || '',
        descriptionSnippet: (j.description || '').slice(0, 800),
        isRemote: !!j.isRemote,
        isContract: !!j.isContract
      }))
    };

    console.log(`Returning ${output.returned} jobs (matched ${output.totalMatchedAfterFilters} of ${output.totalFetched})`);
    return res.json(output);

  } catch (err) {
    console.error('Search handler error', err && (err.stack || err));
    return res.status(500).json({ error: 'Internal server error', detail: err && err.message });
  }
});

app.get('/', (req, res) => {
  res.json({ status: 'linked-jobs-wrapper', live: true, note: 'GET /search?keyword=...&location=...&require_remote=true&require_contract=true&fetch_details=true' });
});

app.listen(PORT, () => {
  console.log(`LinkedIn jobs wrapper listening on ${PORT} — ENV PORT=${PORT}`);
});
