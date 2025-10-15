'use strict';
const dns = require('dns');
const semver = require('semver');
const Parse = require('parse/node');
const CurrentSpecReporter = require('./support/CurrentSpecReporter.js');
const { SpecReporter } = require('jasmine-spec-reporter');
const SchemaCache = require('../lib/Adapters/Cache/SchemaCache').default;
const { sleep, Connections } = require('../lib/TestUtils');

const originalFetch = global.fetch;
let fetchWasMocked = false;

global.restoreFetch = () => {
  global.fetch = originalFetch;
  fetchWasMocked = false;
}


// Ensure localhost resolves to ipv4 address first on node v17+
if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder('ipv4first');
}

// Sets up a Parse API server for testing.
jasmine.DEFAULT_TIMEOUT_INTERVAL = process.env.PARSE_SERVER_TEST_TIMEOUT || 10000;
jasmine.getEnv().addReporter(new CurrentSpecReporter());
jasmine.getEnv().addReporter(new SpecReporter());
global.retryFlakyTests();

global.on_db = (db, callback, elseCallback) => {
  if (process.env.PARSE_SERVER_TEST_DB == db) {
    return callback();
  } else if (!process.env.PARSE_SERVER_TEST_DB && db == 'mongo') {
    return callback();
  }
  if (elseCallback) {
    return elseCallback();
  }
};

if (global._babelPolyfill) {
  console.error('We should not use polyfilled tests');
  process.exit(1);
}
process.noDeprecation = true;

const cache = require('../lib/cache').default;
const defaults = require('../lib/defaults').default;
const ParseServer = require('../lib/index').ParseServer;
const loadAdapter = require('../lib/Adapters/AdapterLoader').loadAdapter;
const path = require('path');
const TestUtils = require('../lib/TestUtils');
const GridFSBucketAdapter = require('../lib/Adapters/Files/GridFSBucketAdapter')
  .GridFSBucketAdapter;
const FSAdapter = require('@parse/fs-files-adapter');
const PostgresStorageAdapter = require('../lib/Adapters/Storage/Postgres/PostgresStorageAdapter')
  .default;
const MongoStorageAdapter = require('../lib/Adapters/Storage/Mongo/MongoStorageAdapter').default;
const RedisCacheAdapter = require('../lib/Adapters/Cache/RedisCacheAdapter').default;
const RESTController = require('parse/lib/node/RESTController').default;
const { VolatileClassesSchemas } = require('../lib/Controllers/SchemaController');

const mongoURI = 'mongodb://localhost:27017/parseServerMongoAdapterTestDatabase';
const postgresURI = 'postgres://localhost:5432/parse_server_postgres_adapter_test_database';
let databaseAdapter;
let databaseURI;

if (process.env.PARSE_SERVER_DATABASE_ADAPTER) {
  databaseAdapter = JSON.parse(process.env.PARSE_SERVER_DATABASE_ADAPTER);
  databaseAdapter = loadAdapter(databaseAdapter);
} else if (process.env.PARSE_SERVER_TEST_DB === 'postgres') {
  databaseURI = process.env.PARSE_SERVER_TEST_DATABASE_URI || postgresURI;
  databaseAdapter = new PostgresStorageAdapter({
    uri: databaseURI,
    collectionPrefix: 'test_',
  });
} else {
  databaseURI = mongoURI;
  databaseAdapter = new MongoStorageAdapter({
    uri: databaseURI,
    collectionPrefix: 'test_',
  });
}

const port = 8378;
const serverURL = `http://localhost:${port}/1`;
let filesAdapter;

on_db(
  'mongo',
  () => {
    filesAdapter = new GridFSBucketAdapter(mongoURI);
  },
  () => {
    filesAdapter = new FSAdapter();
  }
);

let logLevel;
let silent = true;
if (process.env.VERBOSE) {
  silent = false;
  logLevel = 'verbose';
}
if (process.env.PARSE_SERVER_LOG_LEVEL) {
  silent = false;
  logLevel = process.env.PARSE_SERVER_LOG_LEVEL;
}
// Default server configuration for tests.
const defaultConfiguration = {
  filesAdapter,
  serverURL,
  databaseAdapter,
  appId: 'test',
  javascriptKey: 'test',
  dotNetKey: 'windows',
  clientKey: 'client',
  restAPIKey: 'rest',
  webhookKey: 'hook',
  masterKey: 'test',
  maintenanceKey: 'testing',
  readOnlyMasterKey: 'read-only-test',
  fileKey: 'test',
  directAccess: true,
  silent,
  verbose: !silent,
  logLevel,
  liveQuery: {
    classNames: ['TestObject'],
  },
  startLiveQueryServer: true,
  fileUpload: {
    enableForPublic: true,
    enableForAnonymousUser: true,
    enableForAuthenticatedUser: true,
  },
  push: {
    android: {
      senderId: 'yolo',
      apiKey: 'yolo',
    },
  },
  auth: {
    // Override the facebook provider
    custom: mockCustom(),
    facebook: mockFacebook(),
    myoauth: {
      module: path.resolve(__dirname, 'support/myoauth'), // relative path as it's run from src
    },
    shortLivedAuth: mockShortLivedAuth(),
  },
  allowClientClassCreation: true,
  encodeParseObjectInCloudFunction: true,
};

if (silent) {
  defaultConfiguration.logLevels = {
    cloudFunctionSuccess: 'silent',
    cloudFunctionError: 'silent',
    triggerAfter: 'silent',
    triggerBeforeError: 'silent',
    triggerBeforeSuccess: 'silent',
  };
}

// Set up a default API server for testing with default configuration.
let parseServer;
let didChangeConfiguration = false;
const openConnections = new Connections();

const shutdownServer = async (_parseServer) => {
  await _parseServer.handleShutdown();
  // Connection close events are not immediate on node 10+, so wait a bit
  await sleep(0);
  expect(openConnections.count() > 0).toBeFalsy(`There were ${openConnections.count()} open connections to the server left after the test finished`);
  parseServer = undefined;
};

// Allows testing specific configurations of Parse Server
const reconfigureServer = async (changedConfiguration = {}) => {
  if (parseServer) {
    await shutdownServer(parseServer);
    return reconfigureServer(changedConfiguration);
  }
  didChangeConfiguration = Object.keys(changedConfiguration).length !== 0;
  databaseAdapter = new databaseAdapter.constructor({
    uri: databaseURI,
    collectionPrefix: 'test_',
  });
  defaultConfiguration.databaseAdapter = databaseAdapter;
  global.databaseAdapter = databaseAdapter;
  if (filesAdapter instanceof GridFSBucketAdapter) {
    defaultConfiguration.filesAdapter = new GridFSBucketAdapter(mongoURI);
  }
  if (process.env.PARSE_SERVER_TEST_CACHE === 'redis') {
    defaultConfiguration.cacheAdapter = new RedisCacheAdapter();
  }
  const newConfiguration = Object.assign({}, defaultConfiguration, changedConfiguration, {
    mountPath: '/1',
    port,
  });
  cache.clear();
  parseServer = await ParseServer.startApp(newConfiguration);
  Parse.CoreManager.setRESTController(RESTController);
  parseServer.expressApp.use('/1', err => {
    console.error(err);
    fail('should not call next');
  });
  openConnections.track(parseServer.server);
  if (parseServer.liveQueryServer?.server && parseServer.liveQueryServer.server !== parseServer.server) {
    openConnections.track(parseServer.liveQueryServer.server);
  }
  return parseServer;
};

beforeAll(async () => {
  global.restoreFetch();
  await reconfigureServer();
  Parse.initialize('test', 'test', 'test');
  Parse.serverURL = serverURL;
  Parse.User.enableUnsafeCurrentUser();
  Parse.CoreManager.set('REQUEST_ATTEMPT_LIMIT', 1);
});

beforeEach(async () => {
  if(fetchWasMocked) {
    global.restoreFetch();
  }
});

global.afterEachFn = async () => {
  // Restore fetch to prevent mock pollution between tests (only if it was mocked)
  if (fetchWasMocked) {
    global.restoreFetch();
  }

  Parse.Cloud._removeAllHooks();
  Parse.CoreManager.getLiveQueryController().setDefaultLiveQueryClient();
  defaults.protectedFields = { _User: { '*': ['email'] } };

  const allSchemas = await databaseAdapter.getAllClasses().catch(() => []);

  allSchemas.forEach(schema => {
    const className = schema.className;
    expect(className).toEqual({
      asymmetricMatch: className => {
        if (!className.startsWith('_')) {
          return true;
        }
        return [
          '_User',
          '_Installation',
          '_Role',
          '_Session',
          '_Product',
          '_Audience',
          '_Idempotency',
        ].includes(className);
      },
    });
  });
  await Parse.User.logOut().catch(() => {});
  await TestUtils.destroyAllDataPermanently(true);
  SchemaCache.clear();

  if (didChangeConfiguration) {
    await reconfigureServer();
  } else {
    await databaseAdapter.performInitialization({ VolatileClassesSchemas });
  }
}
afterEach(global.afterEachFn);

afterAll(() => {
  global.restoreFetch();
  global.displayTestStats();
});

const TestObject = Parse.Object.extend({
  className: 'TestObject',
});
const Item = Parse.Object.extend({
  className: 'Item',
});
const Container = Parse.Object.extend({
  className: 'Container',
});

// Convenience method to create a new TestObject with a callback
function create(options, callback) {
  const t = new TestObject(options);
  return t.save().then(callback);
}

function createTestUser() {
  const user = new Parse.User();
  user.set('username', 'test');
  user.set('password', 'moon-y');
  return user.signUp();
}

// Shims for compatibility with the old qunit tests.
function ok(bool, message) {
  expect(bool).toBeTruthy(message);
}
function equal(a, b, message) {
  expect(a).toEqual(b, message);
}
function strictEqual(a, b, message) {
  expect(a).toBe(b, message);
}
function notEqual(a, b, message) {
  expect(a).not.toEqual(b, message);
}

// Because node doesn't have Parse._.contains
function arrayContains(arr, item) {
  return -1 != arr.indexOf(item);
}

// Normalizes a JSON object.
function normalize(obj) {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (obj instanceof Array) {
    return '[' + obj.map(normalize).join(', ') + ']';
  }
  let answer = '{';
  for (const key of Object.keys(obj).sort()) {
    answer += key + ': ';
    answer += normalize(obj[key]);
    answer += ', ';
  }
  answer += '}';
  return answer;
}

// Asserts two json structures are equal.
function jequal(o1, o2) {
  expect(normalize(o1)).toEqual(normalize(o2));
}

function range(n) {
  const answer = [];
  for (let i = 0; i < n; i++) {
    answer.push(i);
  }
  return answer;
}

function mockCustomAuthenticator(id, password) {
  const custom = {};
  custom.validateAuthData = function (authData) {
    if (authData.id === id && authData.password.startsWith(password)) {
      return Promise.resolve();
    }
    throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'not validated');
  };
  custom.validateAppId = function () {
    return Promise.resolve();
  };
  return custom;
}

function mockCustom() {
  return mockCustomAuthenticator('fastrde', 'password');
}

function mockFacebookAuthenticator(id, token) {
  const facebook = {};
  facebook.validateAuthData = function (authData) {
    if (authData.id === id && authData.access_token.startsWith(token)) {
      return Promise.resolve();
    } else {
      throw undefined;
    }
  };
  facebook.validateAppId = function (appId, authData) {
    if (authData.access_token.startsWith(token)) {
      return Promise.resolve();
    } else {
      throw undefined;
    }
  };
  return facebook;
}

function mockFacebook() {
  return mockFacebookAuthenticator('8675309', 'jenny');
}

function mockShortLivedAuth() {
  const auth = {};
  let accessToken;
  auth.setValidAccessToken = function (validAccessToken) {
    accessToken = validAccessToken;
  };
  auth.validateAuthData = function (authData) {
    if (authData.access_token == accessToken) {
      return Promise.resolve();
    } else {
      return Promise.reject('Invalid access token');
    }
  };
  auth.validateAppId = function () {
    return Promise.resolve();
  };
  return auth;
}

function mockFetch(mockResponses) {
  const spy = jasmine.createSpy('fetch');
  fetchWasMocked = true; // Track that fetch was mocked for cleanup

  global.fetch = (url, options = {}) => {
    // Allow requests to the Parse Server to pass through WITHOUT recording in spy
    // This prevents tests from failing when they check that fetch wasn't called
    // but the Parse SDK makes internal requests to the Parse Server
    if (typeof url === 'string' && url.includes(serverURL)) {
      return originalFetch(url, options);
    }

    // Record non-Parse-Server calls in the spy
    spy(url, options);

    options.method ||= 'GET';
    const mockResponse = mockResponses?.find(
      (mock) => mock.url === url && mock.method === options.method
    );

    if (mockResponse) {
      return Promise.resolve(mockResponse.response);
    }

    return Promise.resolve({
      ok: false,
      statusText: 'Unknown URL or method',
    });
  };

  // Expose spy methods for test assertions
  global.fetch.calls = spy.calls;
  global.fetch.and = spy.and;
}


// This is polluting, but, it makes it way easier to directly port old tests.
global.Parse = Parse;
global.TestObject = TestObject;
global.Item = Item;
global.Container = Container;
global.create = create;
global.createTestUser = createTestUser;
global.ok = ok;
global.equal = equal;
global.strictEqual = strictEqual;
global.notEqual = notEqual;
global.arrayContains = arrayContains;
global.jequal = jequal;
global.range = range;
global.reconfigureServer = reconfigureServer;
global.mockFetch = mockFetch;
global.defaultConfiguration = defaultConfiguration;
global.mockCustomAuthenticator = mockCustomAuthenticator;
global.mockFacebookAuthenticator = mockFacebookAuthenticator;
global.databaseAdapter = databaseAdapter;
global.databaseURI = databaseURI;
global.shutdownServer = shutdownServer;
global.jfail = function (err) {
  fail(JSON.stringify(err));
};

global.it_exclude_dbs = excluded => {
  if (excluded.indexOf(process.env.PARSE_SERVER_TEST_DB) >= 0) {
    return xit;
  } else {
    return it;
  }
};

let testExclusionList = [];
try {
  // Fetch test exclusion list
  testExclusionList = require('./testExclusionList.json');
  console.log(`Using test exclusion list with ${testExclusionList.length} entries`);
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') {
    throw error;
  }
}

/**
 * Assign ID to test and run it. Disable test if its UUID is found in testExclusionList.
 * @param {String} id The UUID of the test.
 */
global.it_id = id => {
  return testFunc => {
    if (testExclusionList.includes(id)) {
      return xit;
    } else {
      return testFunc;
    }
  };
};

global.it_only_db = db => {
  if (
    process.env.PARSE_SERVER_TEST_DB === db ||
    (!process.env.PARSE_SERVER_TEST_DB && db == 'mongo')
  ) {
    return it;
  } else {
    return xit;
  }
};

global.it_only_mongodb_version = version => {
  if (!semver.validRange(version)) {
    throw new Error('Invalid version range');
  }
  const envVersion = process.env.MONGODB_VERSION;
  if (!envVersion || semver.satisfies(envVersion, version)) {
    return it;
  } else {
    return xit;
  }
};

global.it_only_postgres_version = version => {
  if (!semver.validRange(version)) {
    throw new Error('Invalid version range');
  }
  const envVersion = process.env.POSTGRES_VERSION;
  if (!envVersion || semver.satisfies(envVersion, version)) {
    return it;
  } else {
    return xit;
  }
};

global.it_only_node_version = version => {
  if (!semver.validRange(version)) {
    throw new Error('Invalid version range');
  }
  const envVersion = process.version;
  if (!envVersion || semver.satisfies(envVersion, version)) {
    return it;
  } else {
    return xit;
  }
};

global.fit_only_mongodb_version = version => {
  if (!semver.validRange(version)) {
    throw new Error('Invalid version range');
  }
  const envVersion = process.env.MONGODB_VERSION;
  if (!envVersion || semver.satisfies(envVersion, version)) {
    return fit;
  } else {
    return xit;
  }
};

global.fit_only_postgres_version = version => {
  if (!semver.validRange(version)) {
    throw new Error('Invalid version range');
  }
  const envVersion = process.env.POSTGRES_VERSION;
  if (!envVersion || semver.satisfies(envVersion, version)) {
    return fit;
  } else {
    return xit;
  }
};

global.fit_only_node_version = version => {
  if (!semver.validRange(version)) {
    throw new Error('Invalid version range');
  }
  const envVersion = process.version;
  if (!envVersion || semver.satisfies(envVersion, version)) {
    return fit;
  } else {
    return xit;
  }
};

global.fit_exclude_dbs = excluded => {
  if (excluded.indexOf(process.env.PARSE_SERVER_TEST_DB) >= 0) {
    return xit;
  } else {
    return fit;
  }
};

global.describe_only_db = db => {
  if (process.env.PARSE_SERVER_TEST_DB == db) {
    return describe;
  } else if (!process.env.PARSE_SERVER_TEST_DB && db == 'mongo') {
    return describe;
  } else {
    return xdescribe;
  }
};

global.fdescribe_only_db = db => {
  if (process.env.PARSE_SERVER_TEST_DB == db) {
    return fdescribe;
  } else if (!process.env.PARSE_SERVER_TEST_DB && db == 'mongo') {
    return fdescribe;
  } else {
    return xdescribe;
  }
};

global.describe_only = validator => {
  if (validator()) {
    return describe;
  } else {
    return xdescribe;
  }
};

global.fdescribe_only = validator => {
  if (validator()) {
    return fdescribe;
  } else {
    return xdescribe;
  }
};

const libraryCache = {};
jasmine.mockLibrary = function (library, name, mock) {
  const original = require(library)[name];
  if (!libraryCache[library]) {
    libraryCache[library] = {};
  }
  require(library)[name] = mock;
  libraryCache[library][name] = original;
};

jasmine.restoreLibrary = function (library, name) {
  if (!libraryCache[library] || !libraryCache[library][name]) {
    throw 'Can not find library ' + library + ' ' + name;
  }
  require(library)[name] = libraryCache[library][name];
};

jasmine.timeout = (t = 100) => new Promise(resolve => setTimeout(resolve, t));
