/**
 *    Copyright (C) 2019-present MongoDB, Inc.
 *
 *    This program is free software: you can redistribute it and/or modify
 *    it under the terms of the Server Side Public License, version 1,
 *    as published by MongoDB, Inc.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    Server Side Public License for more details.
 *
 *    You should have received a copy of the Server Side Public License
 *    along with this program. If not, see
 *    <http://www.mongodb.com/licensing/server-side-public-license>.
 *
 *    As a special exception, the copyright holders give permission to link the
 *    code of portions of this program with the OpenSSL library under certain
 *    conditions as described in each individual source file and distribute
 *    linked combinations including the program with the OpenSSL library. You
 *    must comply with the Server Side Public License in all respects for
 *    all of the code used other than as permitted herein. If you modify file(s)
 *    with this exception, you may extend this exception to your version of the
 *    file(s), but you are not obligated to do so. If you do not wish to do so,
 *    delete this exception statement from your version. If you delete this
 *    exception statement from all source files in the program, then also delete
 *    it in the license file.
 */

#pragma once

#include <map>

#include "mongo/db/operation_context.h"
#include "mongo/db/read_write_concern_defaults_gen.h"
#include "mongo/db/repl/read_concern_args.h"
#include "mongo/db/service_context.h"
#include "mongo/db/write_concern_options.h"
#include "mongo/platform/mutex.h"
#include "mongo/util/concurrency/thread_pool.h"
#include "mongo/util/concurrency/with_lock.h"
#include "mongo/util/read_through_cache.h"

namespace mongo {

/**
 * Class to manage Read Concern and Write Concern (RWC) defaults.
 */
class ReadWriteConcernDefaults {
public:
    /**
     * Consistent names for the classes that define a ReadConcern and a WriteConcern.
     */
    using ReadConcern = repl::ReadConcernArgs;
    using WriteConcern = WriteConcernOptions;

    using FetchDefaultsFn = unique_function<boost::optional<RWConcernDefault>(OperationContext*)>;

    static constexpr StringData readConcernFieldName = ReadConcern::kReadConcernFieldName;
    static constexpr StringData writeConcernFieldName = WriteConcern::kWriteConcernField;

    // The _id of the persisted default read/write concern document.
    static constexpr StringData kPersistedDocumentId = "ReadWriteConcernDefaults"_sd;

    static ReadWriteConcernDefaults& get(ServiceContext* service);
    static ReadWriteConcernDefaults& get(OperationContext* opCtx);
    static void create(ServiceContext* service, FetchDefaultsFn fetchDefaultsFn);

    ReadWriteConcernDefaults(ServiceContext* service, FetchDefaultsFn fetchDefaultsFn);
    ~ReadWriteConcernDefaults();

    /**
     * Syntactic sugar around 'getDefault' below. A return value of boost::none means that there is
     * no default specified for that particular concern.
     */
    boost::optional<ReadConcern> getDefaultReadConcern(OperationContext* opCtx);
    boost::optional<WriteConcern> getDefaultWriteConcern(OperationContext* opCtx);

    class RWConcernDefaultAndTime : public RWConcernDefault {
    public:
        RWConcernDefaultAndTime() = default;
        RWConcernDefaultAndTime(RWConcernDefault rwcd, Date_t localUpdateWallClockTime)
            : RWConcernDefault(std::move(rwcd)),
              _localUpdateWallClockTime(localUpdateWallClockTime) {}

        Date_t localUpdateWallClockTime() const {
            return _localUpdateWallClockTime;
        }

    private:
        Date_t _localUpdateWallClockTime;
    };

    /**
     * Returns the current set of read/write concern defaults along with the wallclock time when
     * they were cached (for diagnostic purposes).
     */
    RWConcernDefaultAndTime getDefault(OperationContext* opCtx) {
        return _getDefault(opCtx).value_or(RWConcernDefaultAndTime());
    }

    /**
     * Returns true if the RC level is permissible to use as a default, and false if it cannot be a
     * RC default.
     */
    static bool isSuitableReadConcernLevel(repl::ReadConcernLevel level);

    /**
     * Checks if the given RWC is suitable to use as a default, and uasserts if not.
     */
    static void checkSuitabilityAsDefault(const ReadConcern& rc);
    static void checkSuitabilityAsDefault(const WriteConcern& wc);

    /**
     * Examines a document key affected by a write to config.settings and will register a WUOW
     * onCommit handler that invalidates this cache when the operation commits if the write affects
     * the read/write concern defaults document.
     */
    void observeDirectWriteToConfigSettings(OperationContext* opCtx,
                                            BSONElement idElem,
                                            boost::optional<BSONObj> newDoc);

    /**
     * Generates a new read and write concern default to be persisted on disk, without updating the
     * cached value.
     * At least one of the `rc` or `wc` params must be set.
     * Will generate and use a new epoch and setTime for the updated defaults, which are returned.
     * Validates the supplied read and write concerns can serve as defaults.
     */
    RWConcernDefault generateNewConcerns(OperationContext* opCtx,
                                         const boost::optional<ReadConcern>& rc,
                                         const boost::optional<WriteConcern>& wc);

    /**
     * Invalidates the cached RWC defaults, causing them to be refreshed.
     *
     * After this call returns, the read methods below (getDefault, getDefaultReadConcern,
     * getDefaultWriteConcern) may continue returning the invalidated defaults, until they have been
     * replaced by the refreshed values.  This is to avoid stalling CRUD ops (and other ops that
     * need RC/WC) during refresh.
     */
    void invalidate();

    /**
     * Manually looks up the latest defaults, and if their epoch is more recent than the cached
     * defaults or indicates there are no defaults, then update the cache with the new defaults.
     */
    void refreshIfNecessary(OperationContext* opCtx);

    /**
     * Sets the given read write concern as the defaults in the cache.
     */
    void setDefault(OperationContext* opCtx, RWConcernDefault&& rwc);

    /**
     * Sets implicit default write concern whether it should be majority or not.
     * Should be called once on startup.
     */
    void setImplicitDefaultWriteConcernMajority(bool newImplicitDefaultWCMajority);

private:
    enum class Type { kReadWriteConcernEntry };

    boost::optional<RWConcernDefaultAndTime> _getDefault(OperationContext* opCtx);

    class Cache : public ReadThroughCache<Type, RWConcernDefault> {
        Cache(const Cache&) = delete;
        Cache& operator=(const Cache&) = delete;

    public:
        Cache(ServiceContext* service,
              ThreadPoolInterface& threadPool,
              FetchDefaultsFn fetchDefaultsFn);
        virtual ~Cache() = default;

        boost::optional<RWConcernDefault> lookup(OperationContext* opCtx);

    private:
        Mutex _mutex = MONGO_MAKE_LATCH("ReadWriteConcernDefaults::Cache");

        FetchDefaultsFn _fetchDefaultsFn;
    };

    Cache _defaults;

    // Thread pool on which to perform loading of the cached RWC defaults
    ThreadPool _threadPool;

    // Indicate whether implicit default write concern should be majority or not.
    boost::optional<bool> _implicitDefaultWriteConcernMajority;
};

}  // namespace mongo
