const express = require('express');
const cors = require('cors');
const apicache = require('apicache');
const Xray = require('x-ray');
const x = Xray({
  filters: {
    cleanupText: value => value.replace(new RegExp('\\n', 'g'), '').replace(new RegExp('\\t', 'g'), '').trim()
  }
});
const request = require('request');
const csv = require('csvtojson');
const Twitter = require('twitter');
const fs = require('fs');
const path = require('path');

require('dotenv').config();

const cache = apicache.middleware;
const app = express();
var twitterClient = new Twitter({
  consumer_key: process.env.TWITTER_CONSUMER_KEY,
  consumer_secret: process.env.TWITTER_CONSUMER_SECRET,
  access_token_key: process.env.TWITTER_ACCESS_TOKEN_KEY,
  access_token_secret: process.env.TWITTER_ACCESS_TOKEN_SECRET
});

const socialAccounts = require('./companies');
let wordsToBlock = fs.readFileSync(path.join(__dirname, 'words_to_block.txt'), { encoding: 'utf8' });
wordsToBlock = wordsToBlock.split('\n').map(word => word.trim().toLowerCase());

app.use(cors());
// app.use(cache('1440 minutes'));

/*
* All companies
*/
app.get('/api/companies', cache('1440 minutes'), (req, res) => {
  let companies = [];
  csv()
    .fromStream(
      request.get('https://www.asx.com.au/asx/research/ASXListedCompanies.csv')
    )
    .on('csv', csvRow => {
      companies.push({
        name: csvRow[0],
        symbol: csvRow[1],
        sector: csvRow[2]
      });
    })
    .on('done', error => {
      if (error) {
        return res.json(error);
      }
      companies.splice(0, 2);
      res.json(companies);
    });
});

/*
* Specific company announcements
*/
app.get('/api/company-asx-announcements/:ticker', async (req, res) => {
  const url = 'https://www.asx.com.au';
  const ticker = req.params.ticker.toUpperCase();
  const tickerUrl = `${url}/asx/statistics/announcements.do?by=asxCode&asxCode=${ticker}&timeframe=D&period=M3`;

  const scrape = x(tickerUrl, 'announcement_data table tbody tr', [
    {
      datetime: 'td:nth-child(1)',
      time: 'td:nth-child(1) span.dates-time',
      pdfUrl: 'td:nth-child(3) a@href',
      headline: 'td:nth-child(3) a@text'
    }
  ]);

  scrape((err, result) => {
    if (err) {
      return res.json(err);
    }
    result = result.map(announcement => {
      let datetime = announcement.datetime;
      let [date, time] = datetime.split('\t').join('').split('\n').join(' ').trim().split(/ (.+)/);

      let headline = announcement.headline;
      headline = headline.split('\t').join('').split('\n')[1].trim();

      return {
        date: date.slice(0,10),
        time: time,
        pdfUrl: announcement.pdfUrl,
        headline: headline
      };
    })

    res.json(result);
  });
});

/*
* Top 20 movers
*/
app.get('/api/top-movers', (req, res) => {
  const url = 'http://www.afr.com/markets-data';
  const scrape = x(url, 'div#movers tr', [
    {
      stock: 'td a',
      name: 'td.is-vishidden-mobile'
    }
  ]);
  scrape((err, result) => {
    if (err) {
      return res.json(err);
    }
    res.json(result);
  });
});

/*
* Top 10 gainers
*/
app.get('/api/top-gainers', (req, res) => {
  const url = 'https://au.investing.com/equities/top-stock-gainers';
  const scrape = x(url, '.crossRatesTbl tr', [
    {
      name: 'td a@title'
      //link: 'td a@href'
    }
  ]);
  scrape((err, result) => {
    if (err) {
      return res.json(err);
    }
    console.log('result', result);
    result = result.map(r => {
      r.name = r.name.toLowerCase().replace(' ltd', '');
      r.name = r.name.toLowerCase().replace(' limited', '');
      return r;
    });
    res.json(result);
  });
});

/*
* Top 10 losers
*/
app.get('/api/top-losers', (req, res) => {
  
    const url = 'https://au.investing.com/equities/top-stock-losers';

  scrape((err, result) => {
    if (err) {
      return res.json(err);
    }
    result = result.map(r => {
      r.name = r.name.toLowerCase().replace(' ltd', '');
      r.name = r.name.toLowerCase().replace(' limited', '');
      return r;
    });
    res.json(result);
  });

});


/*
* Twitter search
*/
app.get('/api/twitter-search', (req, res) => {
  const count = req.query.count ? req.query.count : 20;
  req.query.q = req.query.q === '$DRG' ? '$DRG OR $DIG' : req.query.q;
  const query = {
    q: req.query.q,
    count,
    result_type: 'recent',
    tweet_mode: 'extended',
    exclude_replies: true
  };

  if (req.query.since_id) {
    query.since_id = req.query.since_id;
  }

  if (req.query.max_id) {
    query.max_id = req.query.max_id;
  }

  twitterClient.get('search/tweets', query, function(error, tweets, response) {
    if (error) {
      res.status(500).json(error);
      return;
    }

    let filterCount = 0;
    tweets.statuses = tweets.statuses.filter(tweet => {
      let post = (tweet.hasOwnProperty('retweeted_status')) ? `${tweet.full_text.substr(0, tweet.full_text.indexOf(':'))}: ${tweet.retweeted_status.full_text}` : tweet.full_text;

      // pre-process post for comparison to blocked words
      post = post.trim().toLowerCase().replace(new RegExp(`\n`, 'g'), ' ').split(' ').map(word => word.trim()).filter(word => word.length);

      let hasBlockedWords = post.some(word =>wordsToBlock.includes(word));
      if (hasBlockedWords) filterCount++;

      return !hasBlockedWords;
    });

    console.log('filterCount:', filterCount);

    res.json(tweets);
  });
});

/*
* Twitter post
*/
app.post('/api/twitter-post', (req, res) => {
  if (!req.query.msg) {
    res.status(500).json({
      message: 'message cannot be empty'
    });
    return;
  }
  twitterClient.post('statuses/update', { status: req.query.msg }, function(
    error,
    tweet,
    response
  ) {
    if (error) {
      res.status(500).json(error);
      return;
    }
    res.json(tweet);
  });
});

/*
* Twitter timeline
*/
app.get('/api/statuses/:symbol', (req, res) => {
  const twitterAccountIndex = socialAccounts.findIndex(
    social => social['FIELD2'] === req.params.symbol.toUpperCase()
  );

  if (twitterAccountIndex < 0) {
    res.json([]);
    return;
  }

  if (
    !socialAccounts[twitterAccountIndex]['FIELD11'] ||
    socialAccounts[twitterAccountIndex]['FIELD11'] === ''
  ) {
    res.json([]);
    return;
  }

  const count = req.query.count ? req.query.count : 200;
  const query = {
    screen_name: socialAccounts[twitterAccountIndex]['FIELD11'],
    count,
    tweet_mode: 'extended',
    exclude_replies: true
  };

  if (req.query.max_id) {
    query.max_id = req.query.max_id;
  }

  twitterClient.get('statuses/user_timeline', query, function(
    error,
    tweets,
    response
  ) {
    if (error) {
      res.status(500).json(error);
      return;
    }
    res.json(tweets);
  });
});

app.listen(5050);
