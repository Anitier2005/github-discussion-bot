import json
import os
import sys
import unittest
import tempfile
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import bot


class Tests(unittest.TestCase):
    def test_system_prompt_variable_and_file_fallback(self):
        with patch.dict(os.environ, {'BOT_SYSTEM_PROMPT': 'custom system prompt'}):
            self.assertEqual(bot.system_prompt(), 'custom system prompt')
        with patch.dict(os.environ, {'BOT_SYSTEM_PROMPT': '  '}):
            self.assertEqual(bot.system_prompt(), (bot.ROOT/'.github/prompts/system.md').read_text(encoding='utf-8'))

    def test_full_reconcile_and_edit_reuse(self):
        class FakeGitHub:
            def __init__(self):
                self.rows = [dict(id='human', number=1, title='Question', body='/ask what?',
                    url='https://example.test/1', createdAt='0', author={'login': 'alice'}, category={'id': 'general', 'name': 'General'})]
                self.comments = {}
                self.docs = {}
                self.created = 0
            def discussions(self):
                import copy
                return {'id': 'repo', 'discussionCategories': {'nodes': [{'id': 'general', 'name': 'General', 'isAnswerable': False}]}}, copy.deepcopy(self.rows)
            def create(self, repo, category, title, body):
                row = {'id': title, 'number': len(self.rows)+1, 'body': body}
                self.rows.append(row)
                return row
            def connection(self, node, field, fields):
                return self.comments.setdefault(node, [])
            def comment(self, discussion, body, existing=None):
                if existing:
                    next(c for c in self.comments[discussion] if c['id'] == existing)['body'] = body
                else:
                    self.created += 1
                    self.comments.setdefault(discussion, []).append({'id': str(self.created), 'body': body, 'createdAt': '0'})
            def doc(self, key, body):
                self.docs[key] = body
        gh = FakeGitHub()
        with tempfile.TemporaryDirectory() as tmp:
            event_path = Path(tmp)/'event.json'
            event_path.write_text(json.dumps({'sender': {'login': 'alice'}, 'discussion': {'number': 1, 'node_id': 'human', 'body': '/ask what?'}}))
            with patch.dict(os.environ, {'GITHUB_EVENT_PATH': str(event_path), 'LLM_API_KEY': 'test', 'LLM_MODEL': 'test', 'BOT_RULES_PATH': str(bot.ROOT/'.github/discussion-bot/rules.md'), 'BOT_INIT_ONLY': 'false'}), patch.object(bot, 'GitHub', return_value=gh), patch.object(bot, 'generate', return_value={'summary': '# 共识\n需要证据', 'reply': {'reason': 'ask', 'body': 'answer'}}) as model:
                bot.main()
                self.assertEqual(model.call_count, 1)
                self.assertEqual(gh.created, 2)
                summary = next(c['body'] for rows in gh.comments.values() for c in rows if '<!-- category:' in c['body'])
                self.assertEqual(list(gh.docs.values()), [summary])
                bot.main()
                self.assertEqual(model.call_count, 1)
                gh.rows[0]['body'] = '/ask edited?'
                bot.main()
                self.assertEqual(model.call_count, 2)
                self.assertEqual(gh.created, 2)

    def test_prefix_is_stable(self):
        ctx = [{'body': 'fixed context'}]
        a = bot.messages('prompt', 'rules', ctx, {'body': 'old'})
        b = bot.messages('prompt', 'rules', ctx, {'body': 'edited'})
        self.assertEqual(a[:-1], b[:-1])
        self.assertNotEqual(a[-1], b[-1])

    def test_blacklist_and_bot_exclusion(self):
        self.assertTrue(bot.excluded({'author': {'login': 'Alice'}}, {'users': ['alice']}))
        self.assertTrue(bot.excluded({'author': {'login': 'github-actions[bot]'}}, {}))
        self.assertTrue(bot.excluded({'body': bot.TAG + '\nsummary'}, {}))
        self.assertFalse(bot.excluded({'body': 'human question', 'author': None}, {}))

    def test_llm_result_validation(self):
        with patch.dict(os.environ, {'LLM_API_KEY': 'test', 'LLM_MODEL': 'test'}):
            with patch.object(bot, 'request', return_value={'choices': [{'message': {'content': json.dumps({'summary': 'same markdown', 'reply': None})}}]}):
                self.assertEqual(bot.generate([])['summary'], 'same markdown')
            with patch.object(bot, 'request', return_value={'choices': [{'message': {'content': '{"summary": "ok", "reply": {"reason":"spam", "body":"bad"}}'}}]}):
                with self.assertRaises(ValueError):
                    bot.generate([])

    def test_pagination(self):
        gh = object.__new__(bot.GitHub)
        with patch.object(gh, 'gql', side_effect=[
            {'node': {'comments': {'nodes': [{'id': '1'}], 'pageInfo': {'hasNextPage': True, 'endCursor': 'next'}}}},
            {'node': {'comments': {'nodes': [{'id': '2'}], 'pageInfo': {'hasNextPage': False, 'endCursor': None}}}}]) as mock:
            self.assertEqual(len(gh.connection('root', 'comments', 'id')), 2)
            self.assertEqual(mock.call_args.kwargs['cursor'], 'next')

    def test_identical_document_bytes(self):
        gh = object.__new__(bot.GitHub)
        gh.repo, gh.token = 'owner/repo', 'test'
        body = bot.TAG + '\n\n中文 Markdown\n'
        with patch.object(bot, 'request', side_effect=[RuntimeError('HTTP 404 from api.github.com'), {}]) as mock:
            gh.doc('category', body)
            self.assertEqual(bot.base64.b64decode(mock.call_args.args[2]['content']), body.encode())


if __name__ == '__main__':
    unittest.main()
