import express from "express";
import axios from "axios";
import cors from "cors";

const app = express();
app.use(cors());

const PORT = process.env.PORT || 5000;

app.get("/", (req, res) => {
  res.json({ status: "LinkedIn API running" });
});

app.get("/search", async (req, res) => {
  try {
    const { keyword, location, limit = 20, require_remote = false } = req.query;

    const apiUrl = `https://jsearch.p.rapidapi.com/search`;

    const response = await axios.get(apiUrl, {
      params: {
        query: `${keyword} in ${location}`,
        num_pages: 1
      },
      headers: {
        "x-rapidapi-host": "jsearch.p.rapidapi.com",
        "x-rapidapi-key": process.env.RAPID_API_KEY
      }
    });

    res.json({
      jobs: response.data.data || [],
      paramsUsed: req.query
    });

  } catch (err) {
    console.error("API ERROR:", err.message);
    res.status(500).json({ error: "API error", details: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`API running on port ${PORT}`);
});
