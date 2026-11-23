"""Discussion curator. Python 3.11+, no third-party runtime dependencies."""
import base64
import hashlib
import json
import os
import re
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
TAG = '<!-- discussion-curator:v1 -->'
SUMMARY = TAG + '\n<!-- summary -->'
CONTEXT = TAG + '\n<!-- context -->'


def request(url, token, payload=None, method=None):
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, method=method,
        headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json',
                 'User-Agent': 'discussion-curator', 'Accept': 'application/vnd.github+json'})
    try:
        with urllib.request.urlopen(req, timeout=120) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        # Never print request headers, secrets, or provider responses.
        raise RuntimeError(f'HTTP {exc.code} from {url.split("/")[2]}') from None


class GitHub:
    def __init__(self):
        self.token = os.environ['GH_TOKEN']
        self.repo = os.environ['GITHUB_REPOSITORY']

    def gql(self, query, **variables):
        result = request('https://api.github.com/graphql', self.token,
                         {'query': query, 'variables': variables})
        if result.get('errors'):
            raise RuntimeError('GitHub GraphQL operation failed: ' + json.dumps(result['errors']))
        return result['data']

    def connection(self, node, field, fields):
        cursor = None
        result = []
        while True:
            data = self.gql('query($id:ID!,$cursor:String){node(id:$id){... on Discussion {'
                + (f'{field}(first:100,after:$cursor){{nodes{{{fields}}}pageInfo{{hasNextPage endCursor}}}}' if field == 'comments' else '')
                + '} ... on DiscussionComment {'
                + (f'{field}(first:100,after:$cursor){{nodes{{{fields}}}pageInfo{{hasNextPage endCursor}}}}' if field == 'replies' else '')
                + '}}}', id=node, cursor=cursor)['node'][field]
            result.extend(data['nodes'])
            if not data['pageInfo']['hasNextPage']:
                return result
            cursor = data['pageInfo']['endCursor']

    def discussions(self):
        owner, name = self.repo.split('/')
        cursor = None
        result = []
        while True:
            repo = self.gql('''query($owner:String!,$name:String!,$cursor:String){repository(owner:$owner,name:$name){
                id discussionCategories(first:100){nodes{id name isAnswerable}}
                discussions(first:100,after:$cursor,orderBy:{field:CREATED_AT,direction:ASC}){
                nodes{id number title body url createdAt author{login} category{id name}}
                pageInfo{hasNextPage endCursor}}}}''', owner=owner, name=name, cursor=cursor)['repository']
            result.extend(repo['discussions']['nodes'])
            if not repo['discussions']['pageInfo']['hasNextPage']:
                return repo, result
            cursor = repo['discussions']['pageInfo']['endCursor']

    def create(self, repo, category, title, body):
        return self.gql('''mutation($input:CreateDiscussionInput!){createDiscussion(input:$input){discussion{id number body}}}''',
            input={'repositoryId': repo, 'categoryId': category, 'title': title, 'body': body})['createDiscussion']['discussion']

    def comment(self, discussion, body, existing=None):
        if existing:
            self.gql('mutation($input:UpdateDiscussionCommentInput!){updateDiscussionComment(input:$input){comment{id}}}',
                     input={'commentId': existing, 'body': body})
        else:
            self.gql('mutation($input:AddDiscussionCommentInput!){addDiscussionComment(input:$input){comment{id}}}',
                     input={'discussionId': discussion, 'body': body})

    def doc(self, category, body):
        path = f'doc/discussions/{category}.md'
        url = f'https://api.github.com/repos/{self.repo}/contents/{path}'
        try:
            old = request(url, self.token)
        except RuntimeError as exc:
            if 'HTTP 404 ' not in str(exc):
                raise
            old = None
        content = body.encode()
        if old and base64.b64decode(old['content']) == content:
            return
        payload = {'message': f'docs: sync discussion summary {category}',
                   'content': base64.b64encode(content).decode()}
        if old:
            payload['sha'] = old['sha']
        request(url, self.token, payload, 'PUT')


def blacklist():
    value = json.loads(os.getenv('BOT_BLACKLIST', '{}') or '{}')
    for key in ('users', 'discussions', 'categories'):
        if not isinstance(value.get(key, []), list):
            raise ValueError(f'Blacklist {key} must be a list')
    return value


def excluded(item, blocked):
    login = (item.get('author') or {}).get('login', '')
    return (login.lower() in {x.lower() for x in blocked.get('users', [])}
            or login.endswith('[bot]') or item.get('body', '').startswith(TAG))


def messages(prompt, rules, context, source):
    # Stable prefix: no timestamps/event IDs; context comments sorted by creation ID.
    return [{'role': 'system', 'content': prompt},
            {'role': 'system', 'content': rules}] + [
            {'role': 'system', 'content': c['body']} for c in context] + [
            {'role': 'user', 'content': json.dumps(source, ensure_ascii=False, sort_keys=True)}]


def generate(msg):
    endpoint = os.getenv('LLM_BASE_URL', 'https://api.openai.com/v1').rstrip('/')
    if not endpoint.startswith('https://'):
        raise ValueError('LLM_BASE_URL must use HTTPS')
    result = request(endpoint + '/chat/completions', os.environ['LLM_API_KEY'], {
        'model': os.environ['LLM_MODEL'], 'messages': msg,
        'response_format': {'type': 'json_object'}})
    value = json.loads(result['choices'][0]['message']['content'])
    if not isinstance(value.get('summary'), str) or not value['summary'].strip():
        raise ValueError('Missing summary')
    reply = value.get('reply')
    if reply is not None and (not isinstance(reply, dict) or
        reply.get('reason') not in ('ask', 'critical_error') or
        not isinstance(reply.get('body'), str) or not reply['body'].strip()):
        raise ValueError('Invalid reply')
    if len(value['summary']) > 55000 or (reply and len(reply['body']) > 55000):
        raise ValueError('Model response too long for GitHub')
    return value


def main():
    gh = GitHub()
    blocked = blacklist()
    event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text(encoding='utf-8'))
    actor = event.get('sender', {}).get('login', '')
    if actor.lower() in {x.lower() for x in blocked.get('users', [])} or actor.endswith('[bot]'):
        return
    target = event.get('discussion', {})
    if target.get('number') in blocked.get('discussions', []) or target.get('category', {}).get('name') in blocked.get('categories', []):
        return
    # Reconcile all current discussions, so superseded/pending events are safe to coalesce.
    meta, discussions = gh.discussions()
    roots = {}
    for kind, marker in [('summary', SUMMARY), ('context', CONTEXT)]:
        matches = [d for d in discussions if d['body'].startswith(marker)]
        if len(matches) > 1:
            raise ValueError('Duplicate bot root discussions; resolve before continuing')
        if matches:
            roots[kind] = matches[0]
        else:
            categories = meta['discussionCategories']['nodes']
            category = os.getenv('BOT_CATEGORY')
            selected = next((c for c in categories if c['name'] == category), None) if category else next((c for c in categories if not c['isAnswerable']), None)
            if not selected:
                raise ValueError('Enable Discussions and configure BOT_CATEGORY with an open discussion category')
            roots[kind] = gh.create(meta['id'], selected['id'],
                'Discussion Bot — ' + kind,
                marker + '\n\n' + ('自动总结索引：每个板块一条回复；正文与 doc/discussions 完全一致。' if kind == 'summary' else
                '固定上下文入口。此主帖不进入模型上下文。管理员可在下面追加稳定背景或规则；脚本按创建顺序读取所有一级回复，作为可信上下文。模型无法写入或修改本帖及其回复。修改旧回复会使其后的缓存失效。'))
    own_ids = {d['id'] for d in roots.values()}
    if target.get('node_id') in own_ids or target.get('body', '').startswith(TAG):
        return
    if os.getenv('BOT_INIT_ONLY') == 'true':
        print('Bot discussions initialized.')
        return
    if not os.getenv('LLM_API_KEY') or not os.getenv('LLM_MODEL'):
        print('Configure LLM_API_KEY secret and LLM_MODEL variable to enable generation.')
        return
    fields = 'id body createdAt author{login}'
    context = gh.connection(roots['context']['id'], 'comments', fields)
    context.sort(key=lambda c: (c['createdAt'], c['id']))
    existing = gh.connection(roots['summary']['id'], 'comments', fields)
    groups = {}
    # Existing sections remain addressable when their last source is deleted/blocked.
    for category in meta['discussionCategories']['nodes']:
        groups[category['id']] = []
    for discussion in discussions:
        if discussion['id'] in own_ids or excluded(discussion, blocked) or discussion['number'] in blocked.get('discussions', []) or discussion['category']['name'] in blocked.get('categories', []):
            continue
        comments = gh.connection(discussion['id'], 'comments', fields)
        clean = []
        for comment in comments:
            replies = gh.connection(comment['id'], 'replies', fields)
            # Keep eligible replies even when their parent author is blocked.
            clean.extend(r for r in replies if not excluded(r, blocked))
            if not excluded(comment, blocked):
                clean.append(comment)
        clean.sort(key=lambda c: (c['createdAt'], c['id']))
        discussion['comments'] = clean
        groups.setdefault(discussion['category']['id'], []).append(discussion)
    prompt = (ROOT / '.github/prompts/system.md').read_text(encoding='utf-8')
    rules_path = Path(os.getenv('BOT_RULES_PATH', '.github/discussion-bot/rules.md'))
    rules = rules_path.read_text(encoding='utf-8')
    for category, items in sorted(groups.items()):
        key = hashlib.sha256(category.encode()).hexdigest()[:16]
        marker = f'<!-- category:{key} -->'
        previous = next((c for c in existing if c['body'].startswith(TAG + '\n' + marker)), None)
        if not items and not previous:
            continue
        source = {'discussions': items}
        fingerprint = hashlib.sha256(json.dumps([messages(prompt, rules, context, source), os.getenv('LLM_MODEL'), os.getenv('LLM_BASE_URL')], sort_keys=True).encode()).hexdigest()
        stamp = f'<!-- input:{fingerprint} -->'
        if previous and stamp in previous['body']:
            gh.doc(key, previous['body'])
            continue
        # Ask/reply decisions concern the current trigger only, never historical asks.
        trigger = {'discussion': target.get('number'), 'comment': event.get('comment', {}).get('node_id'),
                   'body': event.get('comment', target).get('body', ''), 'active': any(d['number'] == target.get('number') for d in items)}
        source['trigger'] = trigger
        result = generate(messages(prompt, rules, context, source)) if items else {'summary': '本板块当前没有可总结的有效讨论。', 'reply': None}
        body = TAG + '\n' + marker + '\n' + stamp.replace('input:', 'pending:') + '\n\n' + result['summary']
        gh.comment(roots['summary']['id'], body, previous['id'] if previous else None)
        # Re-read after creation; a failed run can safely resume by updating this section.
        saved = next(c for c in gh.connection(roots['summary']['id'], 'comments', fields) if c['body'].startswith(TAG + '\n' + marker))
        if trigger['active'] and result.get('reply'):
            reply = result['reply']
            explicit = bool(re.search(r'(?m)^\s*/ask\b', trigger['body']))
            if reply['reason'] == 'ask' and not explicit:
                reply = None
            origin = trigger['comment'] or target.get('node_id')
            reply_marker = f'<!-- reply:{origin} -->'
            current = next(d for d in items if d['number'] == target['number'])
            comments = gh.connection(current['id'], 'comments', fields)
            old = next((c for c in comments if c['body'].startswith(TAG + '\n' + reply_marker)), None)
            if reply:
                gh.comment(current['id'], TAG + '\n' + reply_marker + '\n\n' + reply['body'], old['id'] if old else None)
        body = body.replace('<!-- pending:', '<!-- input:', 1)
        gh.doc(key, body)
        gh.comment(roots['summary']['id'], body, saved['id'])


if __name__ == '__main__':
    main()
