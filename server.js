const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");

const app = express();
const PORT = process.env.PORT || 5000;

app.get("/search", async (req, res) => {
  try {
    const { keyword, location, limit, require_remote, require_contract } = req.query;

    if (!keyword) return res.status(400).json({ error: "Keyword is required" });

    const searchUrl = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(
      keyword
    )}&location=${encodeURIComponent(location || "United States")}`;

    const response = await axios.get(searchUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      },
    });

    const $ = cheerio.load(response.data);
    let jobs = [];

    $(".base-card").each((i, el) => {
      if (limit && i >= Number(limit)) return;

      const title = $(el).find(".base-search-card__title").text().trim();
      const company = $(el).find(".base-search-card__subtitle").text().trim();
      const loc = $(el).find(".job-search-card__location").text().trim();
      const jobUrl = $(el).find("a.base-card__full-link").attr("href");

      jobs.push({
        title,
        company,
        location: loc,
        url: jobUrl,
      });
    });

    return res.json({
      returned: jobs.length,
      paramsUsed: req.query,
      jobs,
    });
  } catch (err) {
    console.error("ERROR:", err.message);
    res.status(500).json({ error: "Failed to scrape LinkedIn" });
  }
});

app.get("/", (req, res) => {
  res.json({ status: "LinkedIn Job API is running 🚀" });
});

app.listen(PORT, () =>
  console.log(`Server running on port ${PORT}`)
);
