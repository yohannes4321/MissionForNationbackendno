const express = require("express");
const bodyParser = require("body-parser");
require("dotenv").config();

// handle unhandled promise rejections and uncaught exceptions to avoid crashes
process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});

const app = express();

const helmet = require("helmet");
// Disable crossOriginResourcePolicy to allow cross-origin API requests from frontends
app.use(helmet({ crossOriginResourcePolicy: false }));

app.use(bodyParser.json());
const cors = require("cors");

// Allow all origins so both MFN and MFN-Admin-Frontend can connect from anywhere
// (You can lock this down later using an array of allowed URLs)
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

const rateLimit = require("express-rate-limit");
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // limit each IP to 50 requests per window for auth/invite routes
  message: { error: "Too many requests, please try again later." }
});

const authRoutes = require("./routes/auth");
const inviteRoutes = require("./routes/invite");
const adminRoutes = require("./routes/admin");
const blogRoutes = require("./routes/blogs");
const uploadRoutes = require("./routes/upload");

app.use("/auth", authLimiter, authRoutes);
app.use("/api/auth", authLimiter, authRoutes);
app.use("/invite", authLimiter, inviteRoutes);
app.use("/api", adminRoutes);
app.use("/api/blogs", blogRoutes);
app.use("/api", uploadRoutes);

// Backward-compatible alias for clients requesting galleries outside the /api prefix.
app.get("/galleries/all", (req, res) => {
  const query = req.url.includes("?")
    ? req.url.slice(req.url.indexOf("?"))
    : "";
  return res.redirect(`/api/galleries/all${query}`);
});

const port = process.env.PORT || 4000;
// catch-all for unknown routes (prevent crashes when client hits wrong URL)
app.use((req, res, next) => {
  res.status(404).json({ error: "Not found" });
});

// global error handler
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  if (res.headersSent) return next(err);
  
  const isProd = process.env.NODE_ENV === 'production';
  res.status(500).json({ 
    error: isProd ? "Internal Server Error" : (err.message || "Server error")
  });
});

app.listen(port, () => console.log("Server running on port", port));
