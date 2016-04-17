/**
 * Copyright (c) 2016-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @flow
 */

var bl = require('bl');
var config = require('./config');
var express = require('express');
var fs = require('fs');
var mentionBot = require('./mention-bot.js');
var util = require('util');

var GitHubApi = require('github');

var CONFIG_PATH = '.mention-bot';

if (!process.env.GITHUB_TOKEN) {
  console.error('The bot was started without a github account to post with.');
  console.error('To get started:');
  console.error('1) Create a new account for the bot');
  console.error('2) Settings > Personal access tokens > Generate new token');
  console.error('3) Only check `public_repo` and click Generate token');
  console.error('4) Run the following command:');
  console.error('GITHUB_TOKEN=insert_token_here npm start');
  console.error('5) Run the following command in another tab:');
  console.error('curl -X POST -d @__tests__/data/23.webhook http://localhost:5000/');
  console.error('6) Check if it has commented here: https://github.com/fbsamples/bot-testing/pull/23');
  process.exit(1);
}

if (!process.env.GITHUB_USER) {
  console.warn(
    'There was no github user detected.',
    'This is fine, but mention-bot won\'t work with private repos.'
  );
  console.warn(
    'To make mention-bot work with private repos, please expose',
    'GITHUB_USERNAME and GITHUB_PASSWORD as environment variables.',
    'The username and password must have access to the private repo',
    'you want to use.'
  );
}

var github = new GitHubApi({
  version: '3.0.0',
  host: config.github.apiHost,
  pathPrefix: config.github.pathPrefix,
  protocol: config.github.protocol,
  port: config.github.port
});

github.authenticate({
  type: 'oauth',
  token: process.env.GITHUB_TOKEN
});

var app = express();

function buildMentionSentence(reviewers) {
  var atReviewers = reviewers.map(function(owner) { return '@' + owner; });

  if (reviewers.length === 1) {
    return atReviewers[0];
  }

  return (
    atReviewers.slice(0, atReviewers.length - 1).join(', ') +
    ' and ' + atReviewers[atReviewers.length - 1]
  );
}

function messageGenerator(message, reviewers, pullRequester) {
  // replace all @reviwers. message may have more than one '@reviwers'.
  var withReviwers = message.split('@reviwers').join(buildMentionSentence(reviewers));
  // replace all @pullRequester, and return
  return withReviwers.split('@pullRequester').join(pullRequester);
}

function getRepoConfig(request) {
  return new Promise(function(resolve, reject) {
    github.repos.getContent(request, function(err, result) {
      if(err) {
        reject(err);
      }
      resolve(result);
    });
  });
}

async function work(body) {
  var data = {};
  try {
    data = JSON.parse(body.toString());
  } catch (e) {
    console.error(e);
  }

  // default config
  var repoConfig = {
    maxReviewers: 3,
    numFilesToCheck: 5,
    message: '@pullRequester, thanks! @reviwers, please review this.', // TODO: better phrase?
    userBlacklist: [],
    userBlacklistForPR: [],
    userWhitelist: [],
    fileBlacklist: [],
    requiredOrgs: [],
    findPotentialReviewers: true,
    actions: ['opened'],
  };

  try {
    // request config from repo
    var configRes = await getRepoConfig({
      user: data.repository.owner.login,
      repo: data.repository.name,
      path: CONFIG_PATH,
      headers: {
        Accept: 'application/vnd.github.v3.raw'
      }
    });

    repoConfig = {...repoConfig, ...JSON.parse(configRes)};
  } catch (e) {
    console.error(e);
  }

  if (repoConfig.actions.indexOf(data.action) === -1) {
    console.log(
      'Skipping because action is ' + data.action + '.',
      'We only care about: "' + repoConfig.actions.join("', '") + '"'
    );
    return;
  }

  if (process.env.REQUIRED_ORG) {
    repoConfig.requiredOrgs.push(process.env.REQUIRED_ORG);
  }

  if (repoConfig.userBlacklistForPR.indexOf(data.pull_request.user.login) >= 0) {
    console.log('Skipping because blacklisted user created Pull Request.');
    return;
  }

  var org = null;

  if (data.organization) {
    org = data.organization.login;
  }

  var reviewers = await mentionBot.guessOwnersForPullRequest(
    data.repository.html_url, // 'https://github.com/fbsamples/bot-testing'
    data.pull_request.number, // 23
    data.pull_request.user.login, // 'mention-bot'
    data.pull_request.base.ref, // 'master'
    data.repository.private, //true or false
    org, //the org name of the repo
    repoConfig,
    github
  );

  console.log(data.pull_request.html_url, reviewers);

  if (reviewers.length === 0) {
    console.log('Skipping because there are no reviewers found.');
    return;
  }

  // generate message using repoConfig.message
  var message = messageGenerator (repoConfig.message,
                reviewers, '@' + data.pull_request.user.login);

  github.issues.createComment({
    user: data.repository.owner.login, // 'fbsamples'
    repo: data.repository.name, // 'bot-testing'
    number: data.pull_request.number, // 23
    body: message
  });

  return;
};

app.post('/', function(req, res) {
  req.pipe(bl(function(err, body) {
    work(body).then(function() { res.end(); });
 }));
});

app.get('/', function(req, res) {
  res.send(
    'GitHub Mention Bot Active. ' +
    'Go to https://github.com/facebook/mention-bot for more information.'
  );
});

app.set('port', process.env.PORT || 5000);

app.listen(app.get('port'), function() {
  console.log('Listening on port', app.get('port'));
});
