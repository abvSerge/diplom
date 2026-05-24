const MODE = process.env.FAULT_MODE || "none";
const LATENCY_MS = parseInt(process.env.FAULT_LATENCY_MS) || 5000;
const ERROR_RATE = parseFloat(process.env.FAULT_ERROR_RATE) || 0.5;
const PATHS = process.env.FAULT_PATHS || "/posts";

if (MODE !== "none") {
  console.log(
    `[FAULT-INJECTION] режим=${MODE} latency=${LATENCY_MS}мс ` +
      `errorRate=${ERROR_RATE} paths=${PATHS}`,
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = async function faultInjection(req, res, next) {
  if (req.path === "/health" || !req.path.startsWith(PATHS)) {
    return next();
  }

  switch (MODE) {
    case "latency":
      await sleep(LATENCY_MS);
      return next();

    case "error":
      if (Math.random() < ERROR_RATE) {
        return res
          .status(500)
          .json({ error: "Injected failure (fault-injection)" });
      }
      return next();

    case "unavailable":
      return res
        .status(503)
        .json({ error: "Service unavailable (fault-injection)" });

    case "none":
    default:
      return next();
  }
};
