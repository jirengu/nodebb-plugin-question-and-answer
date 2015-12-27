"use strict";

var plugin = {},
	async = module.parent.require('async'),
	topics = module.parent.require('./topics'),
	categories = module.parent.require('./categories'),
	meta = module.parent.require('./meta'),
	privileges = module.parent.require('./privileges'),
	helpers = module.parent.require('./controllers/helpers'),
	db = module.parent.require('./database'),
	SocketPlugins = module.parent.require('./socket.io/plugins');

plugin.init = function(params, callback) {
	var app = params.router,
		middleware = params.middleware,
		controllers = params.controllers;

	app.get('/admin/plugins/question-and-answer', middleware.admin.buildHeader, renderAdmin);
	app.get('/api/admin/plugins/question-and-answer', renderAdmin);

	app.get('/unsolved', middleware.buildHeader, renderUnsolved);
	app.get('/api/unsolved', renderUnsolved);

	app.get('/solved', middleware.buildHeader, renderSolved);
	app.get('/api/solved', renderSolved);

	handleSocketIO();

	callback();
};

plugin.appendConfig = function(config, callback) {
	meta.settings.get('question-and-answer', function(err, settings) {
		config['question-and-answer'] = settings;
		callback(null, config);
	});
};

plugin.addNavigation = function(menu, callback) {
	menu = menu.concat(
		[
			{
				"route": "/未解决",
				"title": "未解决",
				"iconClass": "fa-question-circle",
				"text": "未解决"
			},
			{
				"route": "/已解决",
				"title": "已解决",
				"iconClass": "fa-check-circle",
				"text": "已解决"
			}
		]
	);

	callback (null, menu);
};

plugin.addAdminNavigation = function(header, callback) {
	header.plugins.push({
		route: '/plugins/question-and-answer',
		icon: 'fa-question-circle',
		name: 'Q&A'
	});

	callback(null, header);
};

plugin.getTopics = function(data, callback) {
	var topics = data.topics;

	async.map(topics, function(topic, next) {
		if (parseInt(topic.isQuestion, 10)) {
			if (parseInt(topic.isSolved, 10)) {
				topic.title = '<span class="answered"><i class="fa fa-question-circle"></i> 已解决</span> ' + topic.title;
			} else {
				topic.title = '<span class="unanswered"><i class="fa fa-question-circle"></i> 未解决</span> ' + topic.title;
			}
		}
		
		return next(null, topic);
	}, function(err, topics) {
		return callback(err, data);
	});
};

plugin.addThreadTool = function(data, callback) {
	var isSolved = parseInt(data.topic.isSolved, 10);

	if (parseInt(data.topic.isQuestion, 10)) {
		data.tools = data.tools.concat([
			{
				class: 'toggleSolved ' + (isSolved ? 'alert-warning topic-solved' : 'alert-success topic-unsolved'),
				title: isSolved ? '标记为未解决' : '标记为已解决',
				icon: isSolved ? 'fa-question-circle' : 'fa-check-circle'
			},
			{
				class: 'toggleQuestionStatus',
				title: '变回普通主题',
				icon: 'fa-comments'
			}
		]);	
	} else {
		data.tools.push({
			class: 'toggleQuestionStatus alert-warning',
			title: '问个问题',
			icon: 'fa-question-circle'
		});
	}
	
	callback(false, data);
};

function renderAdmin(req, res, next) {
	async.waterfall([
		async.apply(db.getSortedSetRange, 'categories:cid', 0, -1),
		function(cids, next) {
			categories.getCategoriesFields(cids, ['cid', 'name'], next);
		}
	], function(err, data) {
		res.render('admin/plugins/question-and-answer', {
			categories: data
		});
	});
}

function handleSocketIO() {
	SocketPlugins.QandA = {};

	SocketPlugins.QandA.toggleSolved = function(socket, data, callback) {
		privileges.topics.canEdit(data.tid, socket.uid, function(err, canEdit) {
			if (!canEdit) {
				return callback(new Error('[[error:no-privileges]]'));
			}

			toggleSolved(data.tid, callback);
		});
	};

	SocketPlugins.QandA.toggleQuestionStatus = function(socket, data, callback) {
		privileges.topics.canEdit(data.tid, socket.uid, function(err, canEdit) {
			if (!canEdit) {
				return callback(new Error('[[error:no-privileges]]'));
			}

			toggleQuestionStatus(data.tid, callback);
		});
	};
}

function toggleSolved(tid, callback) {
	topics.getTopicField(tid, 'isSolved', function(err, isSolved) {
		isSolved = parseInt(isSolved, 10) === 1;

		async.parallel([
			function(next) {
				topics.setTopicField(tid, 'isSolved', isSolved ? 0 : 1, next);
			},
			function(next) {
				if (!isSolved) {
					db.sortedSetRemove('topics:unsolved', tid, function() {
						db.sortedSetAdd('topics:solved', Date.now(), tid, next);
					});
				} else {
					db.sortedSetAdd('topics:unsolved', Date.now(), tid, function() {
						db.sortedSetRemove('topics:solved', tid, next);
					});
				}
			}
		], function(err) {
			callback(err, {isSolved: !isSolved});
		});
	});
}

function toggleQuestionStatus(tid, callback) {
	topics.getTopicField(tid, 'isQuestion', function(err, isQuestion) {
		isQuestion = parseInt(isQuestion, 10) === 1;

		async.parallel([
			function(next) {
				topics.setTopicField(tid, 'isQuestion', isQuestion ? 0 : 1, next);
			},
			function(next) {
				if (!isQuestion) {
					async.parallel([
						function(next) {
							topics.setTopicField(tid, 'isSolved', 0, next);
						},
						function(next) {
							db.sortedSetAdd('topics:unsolved', Date.now(), tid, next);
						},
						function(next) {
							db.sortedSetRemove('topics:solved', tid, next);
						}
					], next);
				} else {
					db.sortedSetRemove('topics:unsolved', tid, function() {
						db.sortedSetRemove('topics:solved', tid, next);
					});
				}
			}
		], function(err) {
			callback(err, {isQuestion: !isQuestion});
		});
	});	
}

function renderUnsolved(req, res, next) {
	var stop = (parseInt(meta.config.topicsPerList, 10) || 20) - 1;
	topics.getTopicsFromSet('topics:unsolved', req.uid, 0, stop, function(err, data) {
		if (err) {
			return next(err);
		}

		data['feeds:disableRSS'] = true;
		data.breadcrumbs = helpers.buildBreadcrumbs([{text: '未解决'}]);
		res.render('recent', data);
	});
}

function renderSolved(req, res, next) {
	var stop = (parseInt(meta.config.topicsPerList, 10) || 20) - 1;
	topics.getTopicsFromSet('topics:solved', req.uid, 0, stop, function(err, data) {
		if (err) {
			return next(err);
		}

		data['feeds:disableRSS'] = true;
		data.breadcrumbs = helpers.buildBreadcrumbs([{text: '已解决'}]);
		res.render('recent', data);
	});
}

module.exports = plugin;