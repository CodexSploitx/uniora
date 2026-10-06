import { openSqliteDatabase } from "@uniora/sqlite";
import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 3000);
const { app } = await createApp({ db: openSqliteDatabase(process.env.DB_FILE ?? "example.db"), baseUrl: `http://localhost:${port}` });
app.listen(port, "127.0.0.1", () => console.log(`Example listening on http://127.0.0.1:${port}`));
