#!/usr/bin/env python3
"""preview_policy.py — 多人多群组记忆隔离 / 分级策略离线模拟器。

忠实复刻运行时的两道防御（命名空间白名单 + 可见性闸门）与分级政策解析，
站在某个 (群, 人) 的视角，打印【可读命名空间、群层级、分级政策、群专属提示、
实际会注入的记忆】。可用 --compare 同时跑两个人，证明 A 看不到 B。

只做纯计算：不读写任何数据库、不联网、不依赖第三方库。设计阶段先用它把隔离
验证好，再去动真配置 / 真库。

用法:
    # 不带 --spec 就用内置示例（开箱即跑，演示三级群 + 两个人的隔离）
    python3 scripts/preview_policy.py --chat oc_work --user ou_A
    python3 scripts/preview_policy.py --chat oc_pub --user ou_A --compare ou_B
    python3 scripts/preview_policy.py --chat oc_work --user ou_admin --admin

    # 带自己的规格文件
    python3 scripts/preview_policy.py --spec my-spec.json --chat oc_X --user ou_A

规格文件（JSON）形状:
    {
      "defaultTier": "public",
      "tierPolicies": { "public": "...", "member": "...", "work": "..." },
      "admins": ["ou_admin"],
      "groups": {
        "oc_X": { "name": "示例群", "tier": "member", "systemPromptAppend": "..." }
      },
      "memories": [
        { "namespace": "global",                 "visibility": "public",  "content": "..." },
        { "namespace": "group:oc_X",             "visibility": "group",   "content": "..." },
        { "namespace": "user:ou_A",              "visibility": "private", "content": "..." },
        { "namespace": "group_user:oc_X:ou_A",   "visibility": "private", "content": "..." }
      ]
    }
"""

import argparse
import json
import sys


# 内建分级政策默认文字（与运行时的内建常量对应；中立措辞）。
BUILTIN_TIER_POLICY = {
    "public": "你现在所在的是公开群，面向外部观察者与潜在参与者。可以介绍公开信息、"
    "公开活动与参与方式；不要透露会员群、工作群的内部事务、未公开决策或成员私人信息。"
    "语气友善、简洁、偏公开传播。",
    "member": "你现在所在的是会员群，面向正式会员。可以讨论面向会员的事务与活动；"
    "但不要透露工作群的内部运营细节或未公开决策。语气亲切、具体。",
    "work": "你现在所在的是工作群，面向核心工作成员。可以讨论内部运营、治理、协作等各类事务。",
}

# 每域注入字数预算（与运行时一致）：超出只提示、不在模拟器里强行截断。
GROUP_CHAR_BUDGET = 500
USER_CHAR_BUDGET = 300


# 开箱即跑的内置示例：三级群 + 两个普通人 + 一个管理员，覆盖全部命名空间。
DEMO_SPEC = {
    "defaultTier": "public",
    "admins": ["ou_admin"],
    "groups": {
        "oc_pub": {"name": "示例公开群", "tier": "public",
                   "systemPromptAppend": "你现在在示例公开群，多介绍参与方式，少谈内部进度。"},
        "oc_mem": {"name": "示例会员群", "tier": "member"},
        "oc_work": {"name": "示例工作群", "tier": "work"},
    },
    "memories": [
        {"namespace": "global", "visibility": "public", "content": "公开活动每周三晚上。"},
        {"namespace": "group:oc_work", "visibility": "group", "content": "工作群约定：内部进度只在本群同步。"},
        {"namespace": "group:oc_pub", "visibility": "group", "content": "公开群近期热词：参与、活动、新人。"},
        {"namespace": "user:ou_A", "visibility": "private", "content": "A 偏好简短回答，关注治理。"},
        {"namespace": "user:ou_B", "visibility": "private", "content": "B 是新人，需要引导。"},
        {"namespace": "group_user:oc_work:ou_A", "visibility": "private", "content": "A 在工作群负责排期。"},
        {"namespace": "group:oc_work", "visibility": "admin_only", "content": "仅管理员：本月预算备注。"},
    ],
}


def allowed_namespaces(chat, user):
    """复刻 allowedNamespaces：恰好四个白名单，永远不含别人的命名空间。"""
    return [
        "global",
        f"group:{chat}",
        f"user:{user}",
        f"group_user:{chat}:{user}",
    ]


def filter_by_policy(memories, chat, user, is_admin):
    """复刻 filterByPolicy 的两道防御：命名空间白名单 + 可见性闸门。"""
    allowed = set(allowed_namespaces(chat, user))
    kept = []
    for m in memories:
        ns = m.get("namespace")
        vis = m.get("visibility", "public")
        # ① 命名空间不在白名单一律剔除（纵深防御）。
        if ns not in allowed:
            continue
        # ② admin_only 仅管理员放行。
        if vis == "admin_only":
            if is_admin:
                kept.append(m)
            continue
        # ③ private 仅本人——白名单已保证只有本人的 user:/group_user: 进得来。
        if vis == "private":
            if ns == f"user:{user}" or ns == f"group_user:{chat}:{user}":
                kept.append(m)
            continue
        kept.append(m)
    return kept


def get_chat_tier(spec, chat):
    """复刻 getChatTier：群 tier ?? defaultTier ?? public。"""
    group = spec.get("groups", {}).get(chat)
    if group and group.get("tier"):
        return group["tier"]
    return spec.get("defaultTier", "public")


def get_tier_policy_text(spec, tier):
    """复刻 getTierPolicyText：tierPolicies 覆写 ?? 内建默认。"""
    override = spec.get("tierPolicies", {}).get(tier)
    return override if override else BUILTIN_TIER_POLICY.get(tier, "(未知层级，无政策文字)")


def domain_of(namespace):
    """记忆属于【群域】还是【人域】，用于字数预算提示。"""
    if namespace.startswith("group_user:") or namespace.startswith("user:"):
        return "user"
    if namespace.startswith("group:"):
        return "group"
    return "global"


def render_view(spec, chat, user, is_admin):
    """打印某 (群, 人) 视角的完整策略快照，返回该视角可见的记忆列表。"""
    tier = get_chat_tier(spec, chat)
    group = spec.get("groups", {}).get(chat, {})
    namespaces = allowed_namespaces(chat, user)
    visible = filter_by_policy(spec.get("memories", []), chat, user, is_admin)

    lines = []
    lines.append(f"视角：chat={chat} user={user} admin={is_admin}")
    lines.append(f"群层级：{tier}")
    lines.append(f"分级政策：{get_tier_policy_text(spec, tier)}")
    append = group.get("systemPromptAppend")
    lines.append(f"群专属提示：{append if append else '（无）'}")
    lines.append(f"可读命名空间：{'、'.join(namespaces)}")
    if not visible:
        lines.append("注入记忆（过 Policy Filter 后）：（无）")
    else:
        lines.append("注入记忆（过 Policy Filter 后）：")
        for m in visible:
            lines.append(f"  - [ns={m['namespace']} vis={m.get('visibility', 'public')}] {m['content']}")

    # 字数预算提示：单条超预算会被运行时截断。
    group_total = sum(len(m["content"]) for m in visible if domain_of(m["namespace"]) == "group")
    user_total = sum(len(m["content"]) for m in visible if domain_of(m["namespace"]) == "user")
    warns = []
    if group_total > GROUP_CHAR_BUDGET:
        warns.append(f"群域记忆共 {group_total} 字，超过预算 {GROUP_CHAR_BUDGET}，运行时会截断。")
    if user_total > USER_CHAR_BUDGET:
        warns.append(f"人域记忆共 {user_total} 字，超过预算 {USER_CHAR_BUDGET}，运行时会截断。")
    for w in warns:
        lines.append(f"  ⚠ {w}")

    print("\n".join(lines))
    return visible


def render_compare(spec, chat, user_a, user_b, admin_a, admin_b):
    """同群跑两个人，打印隔离检查：谁看得到、谁看不到、有没有越界。"""
    print("=" * 56)
    vis_a = render_view(spec, chat, user_a, admin_a)
    print("-" * 56)
    vis_b = render_view(spec, chat, user_b, admin_b)
    print("=" * 56)

    set_a = {(m["namespace"], m["content"]) for m in vis_a}
    set_b = {(m["namespace"], m["content"]) for m in vis_b}
    only_a = set_a - set_b
    only_b = set_b - set_a
    common = set_a & set_b

    print(f"隔离检查：chat={chat}  {user_a} vs {user_b}")
    print(f"  仅 {user_a} 可见：{len(only_a)} 条")
    for ns, c in sorted(only_a):
        print(f"    - [ns={ns}] {c}")
    print(f"  仅 {user_b} 可见：{len(only_b)} 条")
    for ns, c in sorted(only_b):
        print(f"    - [ns={ns}] {c}")
    print(f"  两人共同可见：{len(common)} 条（global / 本群 group 等共享域）")

    # 越界断言：A 不该看到任何属于 B 的私有命名空间。
    b_private_prefixes = (f"user:{user_b}", f"group_user:{chat}:{user_b}")
    leaked = [m for m in vis_a if m["namespace"].startswith(b_private_prefixes)]
    if leaked:
        print(f"  ✗ 越界！{user_a} 看到了 {user_b} 的私有记忆：{leaked}")
    else:
        print(f"  ✓ 隔离成立：{user_a} 看不到 {user_b} 的任何私有记忆。")


def load_spec(path):
    if not path:
        return DEMO_SPEC
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def main(argv=None):
    p = argparse.ArgumentParser(
        description="多人多群组记忆隔离 / 分级策略离线模拟器（纯计算，不读写库）。",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("--spec", default=None, help="规格 JSON 文件；省略则用内置示例")
    p.add_argument("--chat", required=True, help="群 chat_id（如 oc_work）")
    p.add_argument("--user", required=True, help="视角用户 open_id（如 ou_A）")
    p.add_argument("--admin", action="store_true", help="把 --user 当管理员（放行 admin_only）")
    p.add_argument("--compare", default=None, help="再跑一个 open_id，打印两人的隔离检查")
    args = p.parse_args(argv)

    try:
        spec = load_spec(args.spec)
    except (OSError, json.JSONDecodeError) as e:
        p.error(f"读取规格文件失败：{e}")

    admins = set(spec.get("admins", []))
    admin_main = args.admin or (args.user in admins)

    if args.compare:
        admin_cmp = args.compare in admins
        render_compare(spec, args.chat, args.user, args.compare, admin_main, admin_cmp)
    else:
        render_view(spec, args.chat, args.user, admin_main)
    return 0


if __name__ == "__main__":
    sys.exit(main())
