"""Inspect changed playbooks with the JumpServer worker's own Ansible parser."""
import json
import posixpath
import re
import sys

import yaml
from ansible.parsing.mod_args import ModuleArgsParser

files = json.load(sys.stdin)
role_tasks = set()
playbooks = {}


def actions(path, tasks):
    for task in tasks or []:
        if 'block' in task:
            for section in ('block', 'rescue', 'always'):
                yield from actions(path, task.get(section))
        else:
            action, args, _ = ModuleArgsParser(task).parse(skip_action_validation=True)
            assert action.count('.') >= 2 and not action.startswith('ansible.legacy.'), f'{path}: unqualified or legacy module {action}'
            yield action, args


for path, content in files.items():
    role = re.search(r'(?:^|/)roles/([^/]+)/(tasks|handlers)/', path)
    data = yaml.safe_load(content)
    if role:
        for action, _ in actions(path, data):
            if role[2] == 'tasks' and action.startswith('ansible.builtin.'):
                role_tasks.add(role[1])
    elif isinstance(data, list):
        roles = set()
        imports = []
        for play in data:
            if not isinstance(play, dict):
                continue
            if 'hosts' in play:
                for entry in play.get('roles', []):
                    roles.add(entry if isinstance(entry, str) else entry['role'])
                for section in ('tasks', 'pre_tasks', 'post_tasks', 'handlers'):
                    for action, args in actions(path, play.get(section)):
                        if action in ('ansible.builtin.include_role', 'ansible.builtin.import_role'):
                            roles.add(args['name'])
            for action in ('import_playbook', 'ansible.builtin.import_playbook'):
                if action in play:
                    assert action.startswith('ansible.builtin.'), f'{path}: short {action}'
                    imports.append(play[action])
        playbooks[path] = (roles, imports)

# Return only entry points that actually invoke a changed role, including imports.


def uses_role(path, seen):
    if path not in playbooks or path in seen:
        return False
    roles, imports = playbooks[path]
    return bool(roles & role_tasks) or any(
        uses_role(posixpath.normpath(posixpath.join(posixpath.dirname(path), item)), seen | {path})
        for item in imports
    )


print(json.dumps([path for path in playbooks if uses_role(path, set())]))
