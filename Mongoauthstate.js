/**
 * MongoDB-backed Baileys auth state.
 * -----------------------------------
 * Render's free/starter web service plan has no persistent disk, so anything
 * written to the local filesystem (e.g. useMultiFileAuthState's folder) is
 * wiped on every deploy/restart. That forces a brand-new WhatsApp device
 * pairing each time, which is exactly the pattern that triggers WhatsApp's
 * anti-abuse "reach-out" lock (error 463) on otherwise-known contacts.
 *
 * This module persists the same data useMultiFileAuthState would write to
 * disk — creds + signal keys — in a single MongoDB document instead, so the
 * WhatsApp device identity survives redeploys without needing a paid disk.
 *
 * Usage:
 *   const { state, saveCreds } = await useMongoAuthState(mongoUrl, sessionId);
 *   const sock = makeWASocket({ auth: { creds: state.creds, keys: state.keys } });
 *   sock.ev.on("creds.update", saveCreds);
 */
import { MongoClient } from "mongodb";
import { BufferJSON, initAuthCreds } from "baileys";

let client = null;
let collection = null;

async function getCollection(mongoUrl) {
  if (collection) return collection;
  client = new MongoClient(mongoUrl, {
    socketTimeoutMS: 45000,
    connectTimeoutMS: 45000,
  });
  await client.connect();
  // Small, infrequently-written documents — default db/collection names below,
  // override via MONGODB_DB / MONGODB_COLLECTION if needed.
  const dbName = process.env.MONGODB_DB || "sdps_whatsapp";
  const collName = process.env.MONGODB_COLLECTION || "baileys_auth";
  collection = client.db(dbName).collection(collName);
  return collection;
}

/**
 * Loads (or creates) the auth state for `sessionId`, backed by MongoDB.
 * Returns { state: { creds, keys }, saveCreds, closeMongo }.
 */
export async function useMongoAuthState(mongoUrl, sessionId = "default") {
  const coll = await getCollection(mongoUrl);

  const credsDocId = `${sessionId}:creds`;
  const keysDocId = (type, id) => `${sessionId}:keys:${type}:${id}`;

  const credsDoc = await coll.findOne({ _id: credsDocId });
  const creds = credsDoc
    ? JSON.parse(JSON.stringify(credsDoc.value), BufferJSON.reviver)
    : initAuthCreds();

  const saveCreds = async () => {
    const serialised = JSON.parse(JSON.stringify(creds, BufferJSON.replacer));
    await coll.updateOne(
      { _id: credsDocId },
      { $set: { value: serialised, updatedAt: new Date() } },
      { upsert: true }
    );
  };

  const keys = {
    get: async (type, ids) => {
      const result = {};
      await Promise.all(
        ids.map(async (id) => {
          const doc = await coll.findOne({ _id: keysDocId(type, id) });
          if (doc) {
            result[id] = JSON.parse(JSON.stringify(doc.value), BufferJSON.reviver);
          }
        })
      );
      return result;
    },
    set: async (data) => {
      const ops = [];
      for (const type in data) {
        for (const id in data[type]) {
          const value = data[type][id];
          const _id = keysDocId(type, id);
          if (value) {
            const serialised = JSON.parse(JSON.stringify(value, BufferJSON.replacer));
            ops.push({
              updateOne: {
                filter: { _id },
                update: { $set: { value: serialised, updatedAt: new Date() } },
                upsert: true,
              },
            });
          } else {
            ops.push({ deleteOne: { filter: { _id } } });
          }
        }
      }
      if (ops.length) await coll.bulkWrite(ops);
    },
  };

  const removeCreds = async () => {
    await coll.deleteMany({ _id: { $regex: `^${sessionId}:` } });
  };

  const closeMongo = async () => {
    if (client) await client.close();
  };

  return { state: { creds, keys }, saveCreds, removeCreds, closeMongo };
}
