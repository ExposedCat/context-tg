import { type Collection, type Db, MongoClient } from "mongodb";
import type { Static, TObject } from "typebox";
import { type Chat, chatSchema } from "./chat.ts";

export type Database = {
	chat: Collection<Chat>;
};

async function ensureCollection<T extends TObject>(
	database: Db,
	name: string,
	schema: T,
): Promise<Collection<Static<T>>> {
	const exists = await database.listCollections({ name }).hasNext();
	if (exists) {
		return database.collection<Static<T>>(name);
	}

	return database.createCollection<Static<T>>(name, {
		validator: {
			$jsonSchema: schema,
		},
	});
}

export function initDatabase() {
	const uri = Deno.env.get("MONGODB_URI");
	if (!uri) {
		throw new Error("MONGODB_URI is not set");
	}

	const client = new MongoClient(uri);

	const connect = async (): Promise<Database> => {
		await client.connect();

		const db = client.db();
		const chat = await ensureCollection(db, "chat", chatSchema);
		const database: Database = { chat };

		return database;
	};

	return connect;
}
