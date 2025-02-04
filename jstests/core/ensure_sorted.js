// Cannot implicitly shard accessed collections because of following errmsg: A single
// update/delete on a sharded collection must contain an exact match on _id or contain the shard
// key.
// @tags: [
//   assumes_unsharded_collection,
//   requires_getmore,
// ]

// SERVER-17011 Tests whether queries which specify sort and batch size can generate results out of
// order due to the ntoreturn hack. The EnsureSortedStage should solve this problem.
(function() {
'use strict';
const collName = "ensure_sorted";
const coll = db[collName];
const docList = [{a: 1, b: 4}, {a: 2, b: 3}, {a: 3, b: 2}, {a: 4, b: 1}];
const batchSize = 2;

coll.drop();
assert.commandWorked(coll.createIndex({a: 1, b: 1}));
assert.commandWorked(coll.insert(docList));

let res = assert.commandWorked(db.runCommand({
    find: collName,
    filter: {a: {$lt: 5}},
    projection: {_id: 0},
    sort: {b: -1},
    batchSize: batchSize
}));
let cursor = new DBCommandCursor(db, res, batchSize);
assert.eq(cursor.next(), {a: 1, b: 4});
assert.eq(cursor.next(), {a: 2, b: 3});

assert.commandWorked(coll.update({b: 2}, {$set: {b: 5}}));
let result = cursor.next();

// We might either drop the document where "b" is 2 from the result set, or we might include the
// old version of this document (before the update is applied). Either is acceptable, but
// out-of-order results are unacceptable.
assert(result.b === 2 || result.b === 1, "cursor returned: " + printjson(result));

// Multi interval index bounds.
coll.drop();
assert.commandWorked(coll.createIndex({a: 1, b: 1}));
assert.commandWorked(coll.insert(docList));

res = assert.commandWorked(db.runCommand({
    find: collName,
    filter: {a: {$in: [1, 2, 3, 4]}, b: {$gt: 0, $lt: 5}},
    projection: {_id: 0},
    sort: {a: 1},
    batchSize: batchSize
}));
cursor = new DBCommandCursor(db, res, batchSize);
assert.eq(cursor.next(), {a: 1, b: 4});
assert.eq(cursor.next(), {a: 2, b: 3});

assert.commandWorked(coll.update({b: 2}, {$set: {b: 10}}));
result = cursor.next();
assert(result.b === 2 || result.b === 1, "cursor returned: " + printjson(result));
})();
