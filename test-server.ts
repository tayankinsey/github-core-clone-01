// Local test server entry point
import { createApp } from './app.ts';

const server = createApp();
const port = 9099;
server.listen(port, () => {
  console.log(`[test] listening on port ${port}`);
});