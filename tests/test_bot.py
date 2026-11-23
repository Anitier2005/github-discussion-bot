import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import bot


class Tests(unittest.TestCase):
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
