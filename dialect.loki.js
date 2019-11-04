const fs        = require('fs');
const crypto    = require('crypto');
const bb        = require('bytebuffer');
const libsignal = require('libsignal');
const ini       = require('loki-launcher/ini');

const SESSION_TTL_MSECS = 120 * 1000; // 2 minutes
const TOKEN_TTL_MINS = 0; // 0 means don't expire

const ADN_SCOPES = 'basic stream write_post follow messages update_profile files export';
const IV_LENGTH = 16;

// mount will set this
let cache;

// our temp database for ephemeral data
const tempDB = {};

// create the abstraction layer, so this can be scaled into IPC later on

//
// start tempdb abstraction layer
//

// registers a token, and it's expiration
// if it's gets validated, it will be promoted
const addTempStorage = (pubKey, token) => {
  if(!tempDB[pubKey]) {
    tempDB[pubKey] = [];
  }
  // consider moving the expiration out of this layer?
  tempDB[pubKey].push({
    token,
    timer: setTimeout(() => {
      deleteTempStorageForToken(pubKey, token)
    }, SESSION_TTL_MSECS)
  });
}

const deleteTempStorageForToken = (pubKey, token) => {
  // maybe an array check?
  if (tempDB[pubKey] === undefined) return;
  for(const i in tempDB[pubKey]) {
    const currentToken = tempDB[pubKey][i];
    if (currentToken.token === token) {
      // remove it by index
      if (currentToken.timer) clearTimeout(currentToken.timer);
      tempDB[pubKey].splice(i, 1);
      if (!tempDB[pubKey].length) {
        // was the last
        delete tempDB[pubKey];
        return;
      }
      // continue incase there's more than one
    }
  }
}

const checkTempStorageForToken = (token) => {
  //console.log('searching for', token)
  // check temp storage
  for(var pubKey in tempDB) {
    const found = tempDB[pubKey].find(tempObjs => {
      const tempToken = tempObjs.token;
      //console.log('pubKey', pubKey, 'token', tempToken);
      if (tempToken === token) return true;
    })
    //console.log('pubKey', pubKey, 'found', found);
    if (found) {
      return true;
    }
  }
  return false;
}

const getTempTokenList = () => {
  return Object.keys(tempDB).map(pubKey => {
    return tempDB[pubKey].map(tempObj => {
      return tempObj.token;
    });
  });
}
//
// end tempdb abstraction layer
//

// verify a token is not in use
const findToken = (token) => {
  return new Promise((res, rej) => {
    // if not found in temp storage
    if (checkTempStorageForToken(token)) {
      return res(true);
    }
    // check database
    cache.getAPIUserToken(token, (usertoken, err) => {
      if (err) {
        return rej(err);
      }
      // report back existence
      //console.log('backend has token', usertoken?true:false, token);
      res(usertoken?true:false);
    });
  });
}

// make a token-like string
const generateString = () => {
  // Temp function
  const TOKEN_LEN = 96;
  let token = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < TOKEN_LEN; i++) {
    token += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return token;
}

const createToken = (pubKey) => {
  return new Promise((res, rej) => {
    findOrCreateUser(pubKey)
      .then(async user => {
        //console.log('Creating token for', user.id)
        // generate new random token and make sure it's not in use
        let inUse = true;
        while(inUse) {
          token = generateString();
          inUse = await findToken(token);
        }
        res(token)
      })
      .catch(e => {
        rej(e);
      });
  });
}

const findOrCreateUser = (pubKey) => {
  return new Promise((res, rej) => {
    cache.getUserID(pubKey, (user, err) => {
      if (err) {
        rej(err);
        return;
      }
      //console.log('findOrCreateUser', pubKey, 'new', user === null);
      if (user === null) {
        // create user
        // "password" (2nd) parameter is not saved/used
        cache.addUser(pubKey, '', (newUser, err2) => {
          if (err2) {
            rej(err2);
          } else {
            //console.log('passing back newly created', newUser)
            res(newUser);
          }
        })
      } else {
        // we have this user
        //console.log('findOrCreateUser', user)
        res(user);
      }
    });
  });
}

const getChallenge = async (pubKey) => {
  // make our local keypair
  const serverKey = libsignal.curve.generateKeyPair();
  // encode server's pubKey in base64
  const serverPubKey64 = bb.wrap(serverKey.pubKey).toString('base64');

  // convert our hex pubKey into binary buffer
  const pubKeyData = Buffer.from(bb.wrap(pubKey, 'hex').toArrayBuffer());

  // mix client pub key with server priv key
  const symKey = libsignal.curve.calculateAgreement(
    pubKeyData,
    serverKey.privKey
  );

  // acquire token
  const token = await createToken(pubKey);
  addTempStorage(pubKey, token);

  // convert our ascii token to binary buffer
  const tokenData = Buffer.from(bb.wrap(token).toArrayBuffer());

  // some randomness
  const iv = crypto.randomBytes(IV_LENGTH);
  const iv64 = bb.wrap(iv).toString('base64');

  // encrypt tokenData with symmetric Key using iv
  const ciphertext = await libsignal.crypto.encrypt(
    symKey,
    tokenData,
    iv
  );

  // make final buffer for cipherText
  const ivAndCiphertext = new Uint8Array(
    iv.byteLength + ciphertext.byteLength
  );
  // add iv
  ivAndCiphertext.set(new Uint8Array(iv));
  // add ciphertext after iv position
  ivAndCiphertext.set(new Uint8Array(ciphertext), iv.byteLength);

  // convert final buffer to base64
  const cipherText64 = bb.wrap(ivAndCiphertext).toString('base64');

  return {
    cipherText64,
    serverPubKey64,
  };
}

// getChallenge only sends token encrypted
// so if we guess a pubKey's token that we've generated, we grant access
const confirmToken = (pubKey, token) => {
  return new Promise(async (res, rej) => {
    // Check to ensure the token submitted has been generated in the last 2 minutes
    if (!checkTempStorageForToken(token)) {
      console.log('token', token, 'not in', getTempTokenList());
      return rej('invalid');
    }
    // Token has been recently generated
    // finally ensure user for pubKey
    const userObj = await findOrCreateUser(pubKey);
    if (!userObj) {
      return rej('user');
    }
    //console.log('confirming token for user', userObj.id);
    // promote token to usable for user
    cache.addUnconstrainedAPIUserToken(userObj.id, 'messenger', ADN_SCOPES, token, TOKEN_TTL_MINS, (tokenObj, err) => {
      if (err) {
        // we'll keep the token in the temp storage, so they can retry
        return rej('tokenCreation');
      }
      // if no, err we assume everything is fine...
      //console.log('addUnconstrainedAPIUserToken result', tokenObj)
      // ok token is now registered
      // remove from temp storage
      deleteTempStorageForToken(pubKey, token);
      // return success
      res(true);
    });
  });
}

const sendresponse = (json, resp) => {
  const ts = new Date().getTime();
  const diff = ts-resp.start;
  if (diff > 1000) {
    // this could be to do the client's connection speed
    // how because we stop the clock before we send the response...
    console.log(`${resp.path} served in ${ts - resp.start}ms`);
  }
  if (json.meta && json.meta.code) {
    resp.status(json.meta.code);
  }
  if (resp.prettyPrint) {
    json=JSON.stringify(json,null,4);
  }
  //resp.set('Content-Type', 'text/javascript');
  resp.type('application/json');
  resp.setHeader("Access-Control-Allow-Origin", "*");
  resp.send(json);
}

module.exports = (app, prefix) => {
  // set cache based on dispatcher object
  cache = app.dispatcher.cache;

  let user_access = {};
  let pubkey_whitelist = {};

  const updateUserAccess = () => {
    if (fs.existsSync('loki.ini')) {
      const ini_bytes = fs.readFileSync('loki.ini')
      disk_config = ini.iniToJSON(ini_bytes.toString())
      console.log('config', disk_config);

      // reset permissions to purge any deletions
      user_access = {};
      // load globals pubkeys from file and set their access level
      for(const pubKey in disk_config.globals) {
        const access = disk_config.globals[pubKey];
        // translate pubKey to id of user
        cache.getUserID(pubKey, (user, err) => {
          if (err) console.error(err);
          // only if user has registered
          if (user) {
            console.log('setting', user.id, 'to', access);
            user_access[user.id] = access;
          } else {
            console.warn('no user object for', pubKey);
          }
        })
      }
      // user_access will always be empty here because async
    }
  }
  updateUserAccess();
  // update every 15 mins
  setInterval(updateUserAccess, 15 * 60 * 1000);

  const passesWhitelist = (pubKey) => {
    // if we have a whitelist
    if (disk_config.whitelist && !disk_config.whitelist[pubKey]) {
      // and you're not on it
      return false;
    }
    // by default everyone is allowed
    return true;
  }

  // I guess we're adding these in chronological order

  app.get(prefix + '/loki/v1/get_challenge', (req, res) => {
    const { pubKey } = req.query;
    if (!pubKey) {
      console.log('get_challenge pubKey missing');
      res.status(422).type('application/json').end(JSON.stringify({
        error: 'PubKey missing',
      }));
      return;
    }

    if (!passesWhitelist(pubKey)) {
      console.log('get_challenge ', pubKey, 'not whitelisted');
      return res.status(401).type('application/json').end(JSON.stringify({
        error: 'not allowed',
      }));
    }

    getChallenge(pubKey).then(keyInfo => {
      res.status(200).type('application/json').end(JSON.stringify(keyInfo));
    }).catch(err => {
      console.log(`Error getting challenge: ${err}`);
      res.status(500).type('application/json').end(JSON.stringify({
        error: err.toString(),
      }));
      return;
    });
  });

  const getChannelModeratorsHandler = async (req, res) => {
    const channelId = parseInt(req.params.id);
    const roles = {
      moderators: [],
    };
    const userids = Object.keys(user_access);
    let userAdnObjects = []
    try {
      userAdnObjects = await getUsers(userids);
    } catch(e) {
      console.error(`Error getting users ${userids}`);
      return res.status(500).type('application/json').end(JSON.stringify(roles));
    }
    roles.moderators = userAdnObjects.map(obj => {
      return obj.username;
    });
    res.status(200).type('application/json').end(JSON.stringify(roles));
  }

  // legacy
  app.get(prefix + '/loki/v1/channel/:id/get_moderators', getChannelModeratorsHandler);
  // new official
  app.get(prefix + '/loki/v1/channels/:id/moderators', getChannelModeratorsHandler);

  app.post(prefix + '/loki/v1/submit_challenge', (req, res) => {
    const { pubKey, token } = req.body;
    if (!pubKey) {
      console.log('submit_challenge pubKey missing');
      res.status(422).type('application/json').end(JSON.stringify({
        error: 'pubKey missing',
      }));
      return;
    }
    if (!passesWhitelist(pubKey)) {
      console.log('get_challenge ', pubKey, 'not whitelisted');
      return res.status(401).type('application/json').end(JSON.stringify({
        error: 'not allowed',
      }));
    }
    if (!token) {
      console.log('submit_challenge token missing');
      res.status(422).type('application/json').end(JSON.stringify({
        error: 'token missing',
      }));
      return;
    }
    confirmToken(pubKey, token).then(confirmation => {
      // confirmation should be true
      res.status(200).end();
    }).catch(err => {
      console.log(`Error confirming challenge: ${err}`);
      // handle errors we know
      if (err == 'invalid') {
        res.status(401).end();
      } else {
        res.status(500).end();
      }
    });
  });

  const getUser = (userid) => {
    return new Promise((res, rej) => {
      cache.getUser(userid, (user, err) => {
        //console.log('getUser', user)
        if (user) {
          res(user);
        } else {
          rej(err);
        }
      });
    });
  }

  const getUsers = (userids) => {
    return new Promise((res, rej) => {
      let results = [];
      let requests = 0;
      let responses = 0;
      let next200 = userids.splice(0, 200);
      while(next200.length) {
        requests++;
        // allow them to overlap
        cache.getUsers(next200, {}, (users, err) => {
          if (err) {
            return rej(err);
          }
          // console.log('getUsers', users)
          results = results.concat(users);
          responses++;
          if (requests === responses) {
            // console.log('results', results);
            return res(results);
          }
        });
        next200 = userids.splice(0, 200);
      }
    });
  }


  const validUser = (token, res, cb) => {
    return new Promise((resolve, rej) => {
      app.dispatcher.getUserClientByToken(token, (usertoken, err) => {
        if (err) {
          console.error('token err', err);
          const resObj={
            meta: {
              code: 500,
              error_message: err
            }
          };
          sendresponse(resObj, res);
          return rej();
        }
        if (usertoken === null) {
          // could be they didn't log in through a server restart
          const resObj={
            meta: {
              code: 401,
              error_message: "Call requires authentication: Authentication required to fetch token."
            }
          };
          sendresponse(resObj, res);
          return rej();
        }
        if (cb) cb(usertoken)
        resolve(usertoken)
      });
    });
  }

  const validGlobal = (token, res, cb) => {
    validUser(token, res, (usertoken) => {
      const list = user_access[usertoken.userid];
      if (!list) {
        // not even on the list
        const resObj={
          meta: {
            code: 401,
            error_message: "Call requires authentication: Authentication required to fetch token."
          }
        };
        return sendresponse(resObj, res);
      }
      if (list.match && list.match(/,/)) {
        return cb(usertoken, list.split(/,/));
      }
      cb(usertoken, true);
    });
  }

  app.get(prefix + '/loki/v1/user_info', (req, res) => {
    validUser(req.token, res, (usertoken) => {
      //console.log('usertoken',  JSON.stringify(usertoken))
      const resObj={
        meta: {
          code: 200,
        },
        data: {
          user_id: usertoken.userid,
          client_id: usertoken.client_id,
          scopes: usertoken.scopes,
          created_at: usertoken.created_at,
          expires_at: usertoken.expires_at,
          moderator_status: user_access[usertoken.userid],
        }
      };
      return sendresponse(resObj, res);
    });
  });

  const deletesHandler = (req, res) => {
    const numId = parseInt(req.params.id);
    //console.log('numId', numId)
    cache.getChannelDeletions(numId, req.apiParams, (interactions, err, meta) => {
      const items = interactions.map(interaction => ({
        delete_at: interaction.datetime,
        message_id: interaction.typeid,
        id: interaction.id
      }));
      const resObj={
        meta: meta,
        data: items
      };
      return sendresponse(resObj, res);
    })
  }

  // backwards compatibilty
  app.get(prefix + '/loki/v1/channel/:id/deletes', deletesHandler);
  // new official URL to keep it consistent
  app.get(prefix + '/loki/v1/channels/:id/deletes', deletesHandler);

const deleteMessage = (msg) => {
  return new Promise(function(resolve, rej) {
    // carry out deletion
    cache.deleteMessage(msg.id, msg.channel_id, (message, delErr) => {
      // handle errors
      if (delErr) {
        console.error('tryDeleteMessage mod deleteMessage err', delErr);
        const resObj={
          meta: {
            code: 500,
            error_message: delErr
          }
        };
        return resolve(resObj);
      }
      // message is { data: 1 }
      const resObj={
        meta: {
          code: 200,
        },
        data: msg
      };
      resObj.data.is_deleted = true;
      //console.log('deleteMessage resolving with', resObj);
      return resolve(resObj);
    });
  })
};

const getMessages = (ids) => {
  return new Promise(function(resolve, rej) {
    cache.getMessage(ids, (messages, getErr) => {
      // handle errors
      if (getErr) {
        console.error('getMessage err', getErr);
        return resolve([500, getErr, false]);
      }

      if (!messages || !messages.length) {
        return resolve([410, 'no messages', false]);
      }
      // single result
      if (!Array.isArray(messages)) {
        messages = [messages];
      }
      resolve([200, false, messages]);
    })
  });
};

  app.delete(prefix + '/loki/v1/messages', (req, res) => {
    if (!req.query.ids) {
      console.log('moderation message mass delete ids empty');
      res.status(422).type('application/json').end(JSON.stringify({
        error: 'ids missing',
      }));
      return;
    }
    let ids = req.query.ids;
    if (ids && ids.match(/,/)) {
      ids = ids.split(/,/);
    }
    if (typeof(ids) === 'string') {
      ids = [ ids ];
    }
    if (ids.length > 200) {
      console.log('moderation message mass delete too many ids, 200<', ids.length);
      res.status(422).type('application/json').end(JSON.stringify({
        error: 'too many ids',
      }));
      return;
    }
    validUser(req.token, res, async usertoken => {
      const [ code, err, messages ] = await getMessages(ids);
      //console.log('user multidelete getMessages result', code, err, messages.length)
      if (err) {
        const resObj = {
          meta: {
            code,
            request: ids,
            err
          },
          data: messages
        };
        return sendresponse(resObj, res);
      }
      const metas = [];
      const datas = [];
      await Promise.all(messages.map(async (msg) => {
        // check our permission
        if (!msg || !msg.user) {
          // not even on the list
          console.warn('no message or user object', msg);
          const resObj={
            meta: {
              code: 500,
              error_message: "No message or user object"
            },
          };
          metas.push(resObj.meta);
          datas.push(msg);
          return;
        }
        if (msg.user.id !== usertoken.userid) {
          // not even on the list
          console.warn('user', usertoken.userid, 'tried to delete users', msg.user.id, 'message', msg.id);
          const resObj={
            meta: {
              code: 403,
              error_message: "Your token does not have permission to delete this resource"
            },
          };
          metas.push(resObj.meta);
          datas.push(msg);
          return;
        }
        // we're allowed to nuke it & carry out deletion
        let resObj;
        resObj = await deleteMessage(msg);
        //console.log('deleteMessage resObj', resObj);
        metas.push(resObj.meta);
        datas.push(resObj.data);
      }));

      resObj = {
        meta: {
          code: code,
          request: ids,
          results: metas
        },
        data: datas
      }
      sendresponse(resObj, res);
    });
  });

const modTryDeleteMessages = (ids, access_list) => {
  return new Promise(async (resolve, rej) => {
    const [ code, err, messages ] = await getMessages(ids);
    if (err) {
      const resObj = {
        meta: {
          code,
          request: ids,
          err
        },
        data: messages
      };
      return resolve(resObj);
    }
    const metas = [];
    const datas = [];
    await Promise.all(messages.map(async (message) => {
      // handle already deleted messages
      if (!message || message.is_deleted) {
        const resObj={
          meta: {
            code: 410,
          }
        };
        return resolve(resObj);
      }

      // if not full access
      if (access_list !== true) {
        // see if this message's channel is on the list
        const allowed = access_list.indexOf(message.channel_id);
        if (allowed === -1) {
          // not allowed to manage this channel
          const resObj={
            meta: {
              code: 403,
              error_message: "You're not allowed to moderation this channel"
            }
          };
          return resolve(resObj);
        }
      }
      //console.log('tryDeleteMessage message', message)

      // carry out deletion
      const resObj = await deleteMessage(message);
      resObj.meta.id = message.id;
      // ok how do we want to aggregate these results...
      metas.push(resObj.meta);
      datas.push(resObj.meta);
    }));
    resObj = {
      meta: {
        code: 200,
        request: ids,
        results: metas
      },
      data: datas
    }
    resolve(resObj);
  });
};

  app.delete(prefix + '/loki/v1/moderation/messages', (req, res) => {
    if (!req.query.ids) {
      console.warn('moderation message mass delete ids empty');
      res.status(422).type('application/json').end(JSON.stringify({
        error: 'ids missing',
      }));
      return;
    }
    let ids = req.query.ids;
    if (ids && ids.match(/,/)) {
      ids = ids.split(/,/);
    }
    if (typeof(ids) === 'string') {
      ids = [ ids ];
    }
    if (ids.length > 200) {
      console.warn('moderation message mass delete too many ids, 200<', ids.length);
      res.status(422).type('application/json').end(JSON.stringify({
        error: 'too many ids',
      }));
      return;
    }
    validGlobal(req.token, res, async (usertoken, access_list) => {
      resObj = await modTryDeleteMessages(ids, access_list);
      sendresponse(resObj, res);
    });
  });

  // single mod delete, deprecated
  app.delete(prefix + '/loki/v1/moderation/message/:id', (req, res) => {
    validGlobal(req.token, res, async (usertoken, access_list) => {
      const numId = parseInt(req.params.id);
      resObj = await modTryDeleteMessages([numId], access_list);
      sendresponse(resObj, res);
    });
  });
}
