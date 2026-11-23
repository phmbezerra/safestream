import { createApp } from './app.js';
const {server}=createApp();const port=Number(process.env.PORT||3001);
server.listen(port,'127.0.0.1',()=>console.log(`SafeStream LAB API at http://127.0.0.1:${port}`));
