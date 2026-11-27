import { createApp } from './app.js';
const {server}=createApp({
 stateFile:process.env.SAFESTREAM_STATE_FILE||null,
 moderatorToken:process.env.SAFESTREAM_MODERATOR_TOKEN ?? null,
 reportStateFile:process.env.SAFESTREAM_REPORT_STATE_FILE||null
});const port=Number(process.env.PORT||3001);
const host=process.env.SAFESTREAM_LAN_IP||'127.0.0.1';
server.listen(port,host,()=>console.log(`SafeStream LAB API at http://${host}:${port}`));
