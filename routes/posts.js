const UTIL = require('../utils/utils');
const HELPER = require('./helper');
var client = require('../utils/steemAPI');
const Remarkable = require('remarkable');
var md = new Remarkable({
    html: true, // remarkable renders first then sanitize runs...
    breaks: true,
    linkify: false, // linkify is done locally
    typographer: false, // https://github.com/jonschlinkert/remarkable/issues/142#issuecomment-221546793
});
const marked = require('marked');
var express = require('express');
var router = express.Router();
var readingTime = require('reading-time');
var Autolinker = require('autolinker');
var Promise = require("bluebird");
var striptags = require('striptags');

const NSFW = ['nsfw', 'NSFW', 'porn', 'dporn', 'Dporn', 'Dporncovideos', 'dporncovideos'];

/**
 * Helper method to get the post
 * @param {*} req 
 * @param {*} res 
 * @param {String} type 
 */
function _get_posts(req, res, next, type, tag) {
    let limit = parseInt(req.query.limit);
    let start_author = req.query.start_author;
    let start_permlink = req.query.start_permlink;
    let username = req.query.username;

    if (tag === "" || tag === null || tag === undefined) {
        tag = '';
    }

    if (Number.isNaN(limit)) {
        return next(HELPER._prepare_error(500, 'Required parameter "limit" is missing.', 'Internal'));
    }

    let object = {
        'limit': limit,
        'tag': tag
    }

    if (start_author !== undefined && start_permlink !== undefined) {
        object.start_author = start_author;
        object.start_permlink = start_permlink;
    }

    client.sendAsync(type, [object]).then(posts => {

        try {
            if (posts.length != 1) {
                let result = posts.map(post => {

                    post.json_metadata = JSON.parse(post.json_metadata);

                    // Check if user has voted this post.
                    post["vote"] = HELPER.is_post_voted(username, post);

                    // Get body image of the post.
                    let image = HELPER.get_body_image(post);

                    // Get videos of the post
                    post.videos = HELPER.get_body_video(post);

                    if (post.videos !== null) {
                        if (post.videos.length == 1 && post.body.trim() == post.videos[0]) {
                            post.video_only = true;
                        }

                        else {
                            post.video_only = false;
                        }
                    }

                    else {
                        post.video_only = false;
                    }

                    post.total_payout_value.amount += post.pending_payout_value.amount;
                    post.author_reputation = UTIL.reputation(post.author_reputation);

                    try {
                        let cond = [];

                        post.json_metadata.tags.forEach(tag => {
                            if (contains(tag, NSFW)) {
                                cond.push(true);
                            }

                            else {
                                cond.push(false);
                            }
                        });

                        if (cond.includes(true)) {
                            post.nsfw = true;
                        }

                        else {
                            post.nsfw = false;
                        }
                    }

                    catch (e) {
                        post.nsfw = false;
                    }

                    if (post.reblogged_by.length > 0) {
                        console.log(post.reblogged_by)
                        post.reblogged_by = post.reblogged_by[0];
                    }

                    else {
                        post.reblogged_by = null;
                    }

                    post.raw_body = post.body;

                    post.body = HELPER.parse_videos(post.raw_body);
                    post.body = HELPER.parse_body(post.body);

                    post.reading_text = readingTime(post.body);

                    let active_votes = post.active_votes.slice(0);
                    active_votes.sort((a,b) => {
                      return b.rshares - a.rshares
                    })

                    let top_likers = HELPER.get_top_likers(active_votes);

                    return _get_response(post, image, top_likers);
                });

                // If pagination, remove the starting element
                if (start_author !== undefined && start_permlink !== undefined) {
                    result.shift();
                }

                let offset = result[result.length - 1].url.split('/')[3];
                let offset_author = result[result.length - 1].author;

                res.send({
                    results: result,
                    offset: offset,
                    offset_author: offset_author
                });
            }

            else {
                res.send({
                    results: [],
                    offset: null,
                    offset_author: null
                });
            }
        }
        catch (e) {
            res.send({
                results: [],
                offset: null,
                offset_author: null
            });
        }

    }).catch(err => {
        res.send({
            results: [],
            offset: null,
            offset_author: null
        });
    })
}

/**
 * Method to prepared response object
 * @param {*} post 
 * @returns Returns an object with the response.
 */
function _get_response(post, image, top_likers) {
    let body = md.render(post.body);

    // Sanitize
    try {
        body = body.replace('&lt;img src=&quot;https://steemitimages.com/0x0/', '');
        body = body.replace('&quot; /&gt;', '');
    } catch (e) { console.log(e) }

    // Autolinker
    body = Autolinker.link(body);

    for(i in post.beneficiaries) {
        post.beneficiaries[i].weight = (post.beneficiaries[i].weight)/100
    }

    let totalPayout =
      parseFloat(post.pending_payout_value) +
      parseFloat(post.total_payout_value) +
      parseFloat(post.curator_payout_value);

    let voteRshares = post.active_votes.reduce((a, b) => a + parseFloat(b.rshares), 0);
    let ratio = totalPayout / voteRshares;
    
    for(i in post.active_votes) {
        post.active_votes[i].value = (post.active_votes[i].rshares * ratio).toFixed(2);
        post.active_votes[i].reputation = UTIL.reputation(post.active_votes[i].reputation);
        post.active_votes[i].percent = post.active_votes[i].percent / 100;
        post.active_votes[i].profile_image = 'https://steemitimages.com/u/' + post.active_votes[i].voter + '/avatar/small'
    }

    let active_votes = post.active_votes.slice(0);
    active_votes.sort((a,b) => {
      return b.value - a.value
    });

    let only_text = striptags(body);
    
    return {
        author: post.author,
        avatar: 'https://steemitimages.com/u/' + post.author + '/avatar/small',
        reblogged_by: post.reblogged_by,
        author_reputation: post.author_reputation,
        title: post.title,
        full_body: body,
        raw_body: post.raw_body,
        only_text: only_text,
        url: post.url,
        created: post.created,
        tags: post.json_metadata.tags,
        category: post.category,
        children: post.children,
        body: image,
        vote: post.vote,
        net_likes: post.net_votes,
        max_accepted_payout: parseFloat(post.max_accepted_payout),
        total_payout_reward: parseFloat(post.total_payout_value) + parseFloat(post.pending_payout_value),
        beneficiaries: post.beneficiaries,
        reading_time: post.reading_text.text,
        root_author: post.root_author,
        root_permlink: post.root_permlink,
        videos: post.videos || null,
        is_nsfw: post.nsfw,
        video_only: post.video_only,
        top_likers_avatars: top_likers,
        votes: active_votes
    };
}

/**
 * Method to retrieve new posts
 */
router.get('/new', (req, res, next) => {

    _get_posts(req, res, next, 'get_discussions_by_created', req.query.tag);
});

/**
 * Method to retrieve trending posts
 */
router.get('/trending', (req, res, next) => {
    
    _get_posts(req, res, next, 'get_discussions_by_trending', req.query.tag);
});

/**
 * Method to retrieve hot posts
 */
router.get('/hot', (req, res, next) => {
    
    _get_posts(req, res, next, 'get_discussions_by_hot', req.query.tag);
});

/**
 * Method to get blog from a specific user
 */
router.get('/blog', (req, res, next) => {
    let user = req.query.user;
    _get_posts(req, res, next, 'get_discussions_by_blog', user);
});

/**
 * Method to get a single post
 * @param {*} req 
 * @param {*} res 
 */

router.get('/info', (req, res, next) => {

    let username = req.query.username;
    let author = req.query.author;
    let permlink = req.query.permlink;

    if (author === null || author === undefined || author === '') {
        if (permlink === null || permlink === undefined || permlink === '') {
            return next(HELPER._prepare_error(500, 'Required parameters "author" and "permlink" are missing.', 'Internal'));
        }
        return next(HELPER._prepare_error(500, 'Required parameter "author" is missing.', 'Internal'));
    }

    else {
        if (permlink === null || permlink === undefined || permlink === '') {
            return next(HELPER._prepare_error(500, 'Required parameter "permlink" is missing.', 'Internal'));
        }
    }

    client.sendAsync('get_content', [author, permlink]).then(post => {
        post.json_metadata = JSON.parse(post.json_metadata);

        // Check if user has voted this post.
        post.vote = HELPER.is_post_voted(username, post);

        // Get body image of the post.
        let image = HELPER.get_body_image(post);

        // Get videos of the post
        post.videos = HELPER.get_body_video(post);

        if (post.videos !== null) {
            if (post.videos.length == 1 && post.body.trim() == post.videos[0]) {
                post.video_only = true;
            }

            else {
                post.video_only = false;
            }
        }

        else {
            post.video_only = false;
        }

        post.total_payout_value.amount += post.pending_payout_value.amount;
        post.author_reputation = UTIL.reputation(post.author_reputation);

        let top_likers = HELPER.get_top_likers(post.active_votes);

        if (post.reblogged_by.length > 0) {
            post.reblogged_by = post.reblogged_by[0];
        }

        else {
            post.reblogged_by = null;
        }

        try {
            let cond = [];

            post.json_metadata.tags.forEach(tag => {
                if (contains(tag, NSFW)) {
                    cond.push(true);
                }

                else {
                    cond.push(false);
                }
            });

            if (cond.includes(true)) {
                post.nsfw = true;
            }

            else {
                post.nsfw = false;
            }
        }

        catch (e) {
            post.nsfw = false;
        }

        post.raw_body = post.body;

        post.body = HELPER.parse_videos(post.raw_body);

        post.body = HELPER.parse_body(post.body);
        post.reading_text = readingTime(post.body);

        res.send(_get_response(post, image, top_likers));

    }).catch(err => console.log(err));
});

/**
 * Method to return feed of a given user
 * @param {*} req 
 * @param {*} res 
 */

router.get('/feed', (req, res, next) => {
    let user = req.query.user;
    let limit = parseInt(req.query.limit);
    let start_author = req.query.start_author;
    let start_permlink = req.query.start_permlink;
    let username = req.query.username;

    if (Number.isNaN(limit)) {
        if (user === null || user === undefined || user === '') {
            return next(HELPER._prepare_error(500, 'Required parameters "user" and "limit" are missing.', 'Internal'));
        }
        return next(HELPER._prepare_error(500, 'Required parameter"limit" is missing.', 'Internal'));
    }

    else {
        if (user === null || user === undefined || user === '') {
            return next(HELPER._prepare_error(500, 'Required parameter "user" is missing.', 'Internal'));
        }
    }

    let object = {
        'limit': limit,
        'tag': user
    }

    if (start_author !== undefined && start_permlink !== undefined) {
        object.start_author = start_author;
        object.start_permlink = start_permlink
    }

    client.sendAsync('get_discussions_by_feed', [object]).then(posts => {

        if (posts.length != 1) {

            let result = posts.map(post => {

                try {
                    post.json_metadata = JSON.parse(post.json_metadata);
                }

                catch (e) {
                }

                // Check if user has voted this post.
                post.vote = HELPER.is_post_voted(username, post);

                // Get body image of the post.
                let image = HELPER.get_body_image(post);

                // Get videos of the post
                post.videos = HELPER.get_body_video(post);

                if (post.videos !== null) {
                    if (post.videos.length == 1 && post.body.trim() == post.videos[0]) {
                        post.video_only = true;
                    }

                    else {
                        post.video_only = false;
                    }
                }

                else {
                    post.video_only = false;
                }

                post.total_payout_value.amount += post.pending_payout_value.amount;
                post.author_reputation = UTIL.reputation(post.author_reputation);

                let top_likers = HELPER.get_top_likers(post.active_votes);

                if (post.reblogged_by.length > 0) {
                    post.reblogged_by = post.reblogged_by[0];
                }

                else {
                    post.reblogged_by = null;
                }

                try {
                    let cond = [];

                    post.json_metadata.tags.forEach(tag => {
                        if (contains(tag, NSFW)) {
                            cond.push(true);
                        }

                        else {
                            cond.push(false);
                        }
                    });

                    if (cond.includes(true)) {
                        post.nsfw = true;
                    }

                    else {
                        post.nsfw = false;
                    }
                }

                catch (e) {
                    post.nsfw = false;
                }

                post.raw_body = post.body;

                post.body = HELPER.parse_videos(post.raw_body);
                post.body = HELPER.parse_body(post.body);


                post.reading_text = readingTime(post.body);

                return _get_response(post, image, top_likers);
            });

            // If pagination, remove the starting element
            if (start_author !== undefined && start_permlink !== undefined) {
                result.shift();
            }

            let offset;
            let offset_author;
            try {
                offset = result[result.length - 1].url.split('/')[3];
                offset_author = result[result.length - 1].author;
            } catch(err) {}

            res.send({
                results: result,
                offset: offset,
                offset_author: offset_author
            });
        }

        else {
            res.send({
                results: [],
                offset: null,
                offset_author: null
            });
        }
    }).catch(err => {
        console.log(err)
        res.send({
            results: [],
            offset: null,
            offset_author: null
        });
    });
});

/**
 * Method to get post comments
 */
router.get('/comments', (req, res, next) => {
    let username = req.query.username;
    let permlink = decodeURIComponent(req.query.permlink);
    let to_delete = permlink.split('/')[2] + "/" + permlink.split('/')[3];
    to_delete = to_delete.replace("@", '');

    if (permlink === undefined || permlink === null || permlink === '') {
        return next(HELPER._prepare_error(500, 'Required parameter "permlink" is missing.', 'Internal'));
    }

    let comments = [];

    client.sendAsync('get_state', [permlink]).then(results => {
        results = JSON.parse(JSON.stringify(results));
        delete results.content[to_delete];

        let result = Object.values(results.content);
        result.sort((a, b) => {
            return b.id > a.id;   // <== to compare string values
        });

        let final = result.map(comment => {
            return {
                body: md.render(comment.body),
                raw_body: comment.body,
                parent_author: comment.parent_author,
                avatar: 'https://steemitimages.com/u/' + comment.author + '/avatar/small',
                created: comment.created,
                url: comment.url,
                permlink: comment.permlink,
                author_reputation: UTIL.reputation(comment.author_reputation),
                author: comment.author,
                category: comment.category,
                net_votes: comment.net_votes,
                net_likes: comment.net_likes,
                pending_payout_value: parseFloat(comment.total_payout_value) + parseFloat(comment.pending_payout_value),
                vote: HELPER.is_post_voted(username, comment),
                children: comment.children
            }
        });
        final.reverse();
        res.send({
            results: final
        });
    }).catch(err => {
        res.send({
            results: []
        });
    });
});

router.get('/comments-new', (req, res, next) => {
    let author = req.query.author;
    let permlink = decodeURIComponent(req.query.permlink);
    let username = req.query.username;
    permlink = permlink.split('/')[3];


    let fetchReplies = (author, permlink) => {
        return client.sendAsync('get_content_replies', [author, permlink])
            .then((replies) => {
                return Promise.map(replies, (r) => {
                    if (r.children > 0) {
                        return fetchReplies(r.author, r.permlink)
                            .then((children) => {
                                let vote = HELPER.is_post_voted(username, r);
                                return {
                                    body: md.render(r.body),
                                    raw_body: r.body,
                                    parent_author: r.parent_author,
                                    avatar: 'https://steemitimages.com/u/' + r.author + '/avatar/small',
                                    created: r.created,
                                    url: r.url,
                                    permlink: r.permlink,
                                    author_reputation: UTIL.reputation(r.author_reputation),
                                    author: r.author,
                                    category: r.category,
                                    net_votes: r.net_votes,
                                    net_likes: r.net_likes,
                                    pending_payout_value: parseFloat(r.total_payout_value) + parseFloat(r.pending_payout_value),
                                    vote: vote,
                                    children: r.children,
                                    replies: children
                                }

                            });
                    } else {
                        let vote = HELPER.is_post_voted(username, r);
                        return {
                            body: md.render(r.body),
                            raw_body: r.body,
                            parent_author: r.parent_author,
                            avatar: 'https://steemitimages.com/u/' + r.author + '/avatar/small',
                            created: r.created,
                            url: r.url,
                            permlink: r.permlink,
                            author_reputation: UTIL.reputation(r.author_reputation),
                            author: r.author,
                            category: r.category,
                            net_votes: r.net_votes,
                            net_likes: r.net_likes,
                            pending_payout_value: parseFloat(r.total_payout_value) + parseFloat(r.pending_payout_value),
                            vote: vote,
                            children: r.children,
                            replies: []
                        }
                    }
                });
            });
    }

    client.sendAsync('get_content', [author, permlink])
        .then((post) => {
            return fetchReplies(author, permlink)
                .then((comments) => {
                    post.replies = comments;
                    return post;
                });
        })
        .then((post) => {
            res.send({
                results: post.replies
            })
        })
        .catch(err => console.log(err));
});

/**
 * Method to retrieve post votes
 */
router.get('/votes', (req, res, next) => {
    let url = req.query.permlink;
    let author = req.query.author;

    if (author === null || author === undefined || author === '') {
        if (url === null || url === undefined || url === '') {
            return next(HELPER._prepare_error(500, 'Required parameters "author" and "permlink" are missin?., m.', 'Internal'));
        }
        return next(HELPER._prepare_error(500, 'Required parameter "author" is missing.', 'Internal'));
    }

    else {
        if (url === null || url === undefined || url === '') {
            return next(HELPER._prepare_error(500, 'Required parameter "permlink" is missing.', 'Internal'));
        }
    }

    client.sendAsync('get_active_votes', [author, url]).then(votes => {
        let results = votes.map(voter => {
            voter.reputation = UTIL.reputation(voter.reputation);
            voter.percent = voter.percent / 100;

            if (voter.percent === 0) {
                return;
            }
            return {
                profile_image: 'https://steemitimages.com/u/' + voter.voter + '/avatar/small',
                username: voter.voter,
                reputation: voter.reputation,
                percent: voter.percent
            }
        });

        results.clean(null);
        res.send({
            results: results
        });
    }).catch(err => {
        res.send({
            results: []
        });
    });
});

Array.prototype.clean = (deleteValue) => {
    for (var i = 0; i < this.length; i++) {
        if (this[i] == deleteValue) {
            this.splice(i, 1);
            i--;
        }
    }
    return this;
};

function contains(target, pattern) {
    var value = 0;
    pattern.forEach((word) => {
        value = value + target.includes(word);
    });
    return (value === 1)
}

module.exports = router;
