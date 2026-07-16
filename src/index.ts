import { runServer } from "./server.js";

runServer().catch((error) => {
  console.error(error);
  process.exit(1);
});
