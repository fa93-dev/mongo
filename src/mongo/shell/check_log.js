/*
 * Helper functions which connect to a server, and check its logs for particular strings.
 */
var checkLog;

(function() {
"use strict";

if (checkLog) {
    return;  // Protect against this file being double-loaded.
}

checkLog = (function() {
    let getGlobalLog = function(conn) {
        assert(typeof conn !== 'undefined', "Connection is undefined");
        let cmdRes;
        try {
            cmdRes = conn.adminCommand({getLog: 'global'});
        } catch (e) {
            // Retry with network errors.
            print("checkLog ignoring failure: " + e);
            return null;
        }

        return assert.commandWorked(cmdRes).log;
    };

    /*
     * Calls the 'getLog' function on the provided connection 'conn' to see if the provided msg
     * is found in the logs. Note: this function does not throw an exception, so the return
     * value should not be ignored.
     */
    const checkContainsOnce = function(conn, msg) {
        const logMessages = getGlobalLog(conn);
        if (logMessages === null) {
            return false;
        }
        if (msg instanceof RegExp) {
            for (let logMsg of logMessages) {
                if (logMsg.search(msg) != -1) {
                    return true;
                }
            }
        } else {
            for (let logMsg of logMessages) {
                if (logMsg.includes(msg)) {
                    return true;
                }
            }
        }
        return false;
    };

    const checkContainsOnceJson = function(conn, id, attrsDict, severity = null) {
        const logMessages = getGlobalLog(conn);
        if (logMessages === null) {
            return false;
        }

        for (let logMsg of logMessages) {
            let obj;
            try {
                obj = JSON.parse(logMsg);
            } catch (ex) {
                print('checkLog.checkContainsOnce: JsonJSON.parse() failed: ' + tojson(ex) + ': ' +
                      logMsg);
                throw ex;
            }

            if (_compareLogs(obj, id, severity, attrsDict)) {
                return true;
            }
        }

        return false;
    };

    const checkContainsWithCountJson = function(
        conn, id, attrsDict, expectedCount, severity = null) {
        const logMessages = getGlobalLog(conn);
        if (logMessages === null) {
            return false;
        }

        let count = 0;
        for (let logMsg of logMessages) {
            let obj;
            try {
                obj = JSON.parse(logMsg);
            } catch (ex) {
                print('checkLog.checkContainsOnce: JsonJSON.parse() failed: ' + tojson(ex) + ': ' +
                      logMsg);
                throw ex;
            }

            if (_compareLogs(obj, id, severity, attrsDict)) {
                count++;
            }
        }
        return count === expectedCount;
    };

    /*
     * Calls the 'getLog' function on the provided connection 'conn' to see if a log with the
     * provided id is found in the logs. If the id is found it looks up the specified attrribute by
     * attrName and checks if the msg is found in its value. Note: this function does not throw an
     * exception, so the return value should not be ignored.
     */
    const checkContainsOnceJsonStringMatch = function(conn, id, attrName, msg) {
        const logMessages = getGlobalLog(conn);
        if (logMessages === null) {
            return false;
        }

        for (let logMsg of logMessages) {
            if (logMsg.search(`\"id\":${id},`) != -1) {
                if (logMsg.search(`\"${attrName}\":\"?[^\"|\\\"]*` + msg) != -1) {
                    return true;
                }
            }
        }

        return false;
    };

    /*
     * Calls the 'getLog' function at regular intervals on the provided connection 'conn' until
     * the provided 'msg' is found in the logs, or it times out. Throws an exception on timeout.
     */
    let contains = function(conn, msg, timeout = 5 * 60 * 1000, retryIntervalMS = 300) {
        // Don't run the hang analyzer because we don't expect contains() to always succeed.
        assert.soon(
            function() {
                return checkContainsOnce(conn, msg);
            },
            'Could not find log entries containing the following message: ' + msg,
            timeout,
            retryIntervalMS,
            {runHangAnalyzer: false});
    };

    let containsJson = function(conn, id, attrsDict, timeout = 5 * 60 * 1000) {
        // Don't run the hang analyzer because we don't expect contains() to always succeed.
        assert.soon(
            function() {
                return checkContainsOnceJson(conn, id, attrsDict);
            },
            'Could not find log entries containing the following id: ' + id +
                ', and attrs: ' + tojson(attrsDict),
            timeout,
            300,
            {runHangAnalyzer: false});
    };

    /*
     * Calls the 'getLog' function at regular intervals on the provided connection 'conn' until
     * the provided 'msg' is found in the logs 'expectedCount' times, or it times out.
     * Throws an exception on timeout. If 'exact' is true, checks whether the count is exactly
     * equal to 'expectedCount'. Otherwise, checks whether the count is at least equal to
     * 'expectedCount'. Early returns when at least 'expectedCount' entries are found.
     */
    let containsWithCount = function(
        conn, msg, expectedCount, timeout = 5 * 60 * 1000, exact = true) {
        let expectedStr = exact ? 'exactly ' : 'at least ';
        assert.soon(
            function() {
                let count = 0;
                let logMessages = getGlobalLog(conn);
                if (logMessages === null) {
                    return false;
                }
                for (let i = 0; i < logMessages.length; i++) {
                    if (msg instanceof RegExp) {
                        if (logMessages[i].search(msg) != -1) {
                            count++;
                        }
                    } else {
                        if (logMessages[i].indexOf(msg) != -1) {
                            count++;
                        }
                    }
                    if (!exact && count >= expectedCount) {
                        print("checkLog found at least " + expectedCount +
                              " log entries containing the following message: " + msg);
                        return true;
                    }
                }

                return exact ? expectedCount === count : expectedCount <= count;
            },
            'Did not find ' + expectedStr + expectedCount + ' log entries containing the ' +
                'following message: ' + msg,
            timeout,
            300);
    };

    /*
     * Similar to containsWithCount, but checks whether there are at least 'expectedCount'
     * instances of 'msg' in the logs.
     */
    let containsWithAtLeastCount = function(conn, msg, expectedCount, timeout = 5 * 60 * 1000) {
        containsWithCount(conn, msg, expectedCount, timeout, /*exact*/ false);
    };

    /*
     * Converts a scalar or object to a string format suitable for matching against log output.
     * Field names are not quoted, and by default strings which are not within an enclosing
     * object are not escaped. Similarly, integer values without an enclosing object are
     * serialized as integers, while those within an object are serialized as floats to one
     * decimal point. NumberLongs are unwrapped prior to serialization.
     */
    const formatAsLogLine = function(value, escapeStrings, toDecimal) {
        if (typeof value === "string") {
            return (escapeStrings ? `"${value}"` : value);
        } else if (typeof value === "number") {
            return (Number.isInteger(value) && toDecimal ? value.toFixed(1) : value);
        } else if (value instanceof NumberLong) {
            return `${value}`.match(/NumberLong..(.*)../m)[1];
        } else if (typeof value !== "object") {
            return value;
        } else if (Object.keys(value).length === 0) {
            return Array.isArray(value) ? "[]" : "{}";
        }
        let serialized = [];
        escapeStrings = toDecimal = true;
        for (let fieldName in value) {
            const valueStr = formatAsLogLine(value[fieldName], escapeStrings, toDecimal);
            serialized.push(Array.isArray(value) ? valueStr : `${fieldName}: ${valueStr}`);
        }
        return (Array.isArray(value) ? `[ ${serialized.join(', ')} ]`
                                     : `{ ${serialized.join(', ')} }`);
    };

    /**
     * Format at the json for the log file which has no extra spaces.
     */
    const formatAsJsonLogLine = function(value, escapeStrings, toDecimal) {
        if (typeof value === "string") {
            return (escapeStrings ? `"${value}"` : value);
        } else if (typeof value === "number") {
            return (Number.isInteger(value) && toDecimal ? value.toFixed(1) : value);
        } else if (value instanceof NumberLong) {
            return `${value}`.match(/NumberLong..(.*)../m)[1];
        } else if (typeof value !== "object") {
            return value;
        } else if (Object.keys(value).length === 0) {
            return Array.isArray(value) ? "[]" : "{}";
        }
        let serialized = [];
        escapeStrings = true;
        for (let fieldName in value) {
            const valueStr = formatAsJsonLogLine(value[fieldName], escapeStrings, toDecimal);
            serialized.push(Array.isArray(value) ? valueStr : `"${fieldName}":${valueStr}`);
        }
        return (Array.isArray(value) ? `[${serialized.join(',')}]` : `{${serialized.join(',')}}`);
    };

    // Internal helper to compare objects filed by field.
    const _deepEqual = function(object1, object2) {
        if (object1 == null || object2 == null) {
            return false;
        }
        const keys1 = Object.keys(object1);
        const keys2 = Object.keys(object2);

        if (keys1.length !== keys2.length) {
            return false;
        }

        for (const key of keys1) {
            const val1 = object1[key];
            const val2 = object2[key];
            const areObjects = _isObject(val1) && _isObject(val2);
            if (areObjects && !_deepEqual(val1, val2) || !areObjects && val1 !== val2) {
                return false;
            }
        }

        return true;
    };

    // Internal helper to check that the argument is a non-null object.
    const _isObject = function(object) {
        return object != null && typeof object === 'object';
    };

    // Internal helper to check if a log's id, severity, and attributes match with what's expected.
    const _compareLogs = function(obj, id, severity, attrsDict) {
        if (obj.id !== id) {
            return false;
        }
        if (severity !== null && obj.s !== severity) {
            return false;
        }

        for (let attrKey in attrsDict) {
            const attrValue = attrsDict[attrKey];
            if (attrValue instanceof Function) {
                if (!attrValue(obj.attr[attrKey])) {
                    return false;
                }
            } else if (obj.attr[attrKey] !== attrValue && typeof obj.attr[attrKey] == "object") {
                if (!_deepEqual(obj.attr[attrKey], attrValue)) {
                    return false;
                }
            } else {
                if (obj.attr[attrKey] !== attrValue) {
                    return false;
                }
            }
        }
        return true;
    };

    return {
        getGlobalLog: getGlobalLog,
        checkContainsOnce: checkContainsOnce,
        checkContainsOnceJson: checkContainsOnceJson,
        checkContainsWithCountJson: checkContainsWithCountJson,
        checkContainsOnceJsonStringMatch: checkContainsOnceJsonStringMatch,
        contains: contains,
        containsJson: containsJson,
        containsWithCount: containsWithCount,
        containsWithAtLeastCount: containsWithAtLeastCount,
        formatAsLogLine: formatAsLogLine,
        formatAsJsonLogLine: formatAsJsonLogLine
    };
})();
})();
