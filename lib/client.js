window.__ModuleLoader__.load({
  id: "dsh-enterprise-team",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const h = react.createElement;

    const NS = "enterprise-team";
    const KIND = "enterprise-team";
    const HEADER_SLOT = "conversation.session.header.actions";
    const BODY_SLOT = "sidebar.right.pane.tab";

    /** Client services this plugin needs before it may apply. */
    const inject = ["slots", "sessions", "locale", "sidebarRightTabs", "sidebarRight", "remote", "remote.session"];

    const zh = { trigger: "企业团队", title: "企业团队" };
    const en = { trigger: "Team", title: "Enterprise Team" };

    const cell = { padding: "4px 10px", textAlign: "left", whiteSpace: "nowrap" };
    const head = { ...cell, color: "var(--dsw-alias-label-tertiary, #999)", fontWeight: 500 };
    const rowStyle = { borderTop: "1px solid var(--dsw-alias-border-subtle, #333)" };
    const field = {
      padding: "4px 8px",
      borderRadius: 6,
      border: "1px solid var(--dsw-alias-border-strong, #3a3a3a)",
      background: "var(--dsw-alias-bg-base, #161616)",
      color: "var(--dsw-alias-label-primary, #eee)",
      fontSize: 12,
    };
    const primaryButton = {
      ...field,
      cursor: "pointer",
      background: "var(--dsw-alias-bg-accent, #2b5cff)",
      borderColor: "transparent",
      color: "#fff",
      fontWeight: 600,
    };
    const ghostButton = { ...field, cursor: "pointer", background: "transparent" };

    /** Render one table from a header row and body rows. */
    function table(headers, rows) {
      return h(
        "table",
        { style: { borderCollapse: "collapse", width: "100%", fontSize: 12 } },
        h(
          "thead",
          { key: "h" },
          h(
            "tr",
            null,
            headers.map((label, index) => h("th", { key: "h" + index, style: head }, label)),
          ),
        ),
        h(
          "tbody",
          { key: "b" },
          rows.length === 0
            ? h("tr", null, h("td", { style: { ...cell, color: "#888" }, colSpan: headers.length }, "—"))
            : rows.map((cells, index) =>
                h(
                  "tr",
                  { key: "r" + index, style: rowStyle },
                  cells.map((value, column) => h("td", { key: "c" + column, style: cell }, String(value ?? ""))),
                ),
              ),
        ),
      );
    }

    /** Section title inside the tab. */
    function section(title, trailing) {
      return h(
        "div",
        { style: { display: "flex", alignItems: "center", justifyContent: "space-between", margin: "14px 0 6px" } },
        h("div", { style: { fontSize: 11, fontWeight: 600 } }, title),
        trailing ?? null,
      );
    }

    /** Compose the instruction that makes the Lead create the drafted Team. */
    function createInstruction(draft) {
      const payload = {
        name: draft.name,
        ...(draft.goal === "" ? {} : { goal: draft.goal }),
        ...(draft.templateId === null ? {} : { template: draft.templateId }),
        ...(draft.leadProvider && draft.leadModel
          ? {
              lead: {
                provider: draft.leadProvider,
                model: draft.leadModel,
                ...(draft.leadEffort ? { reasoningEffort: draft.leadEffort } : {}),
              },
            }
          : {}),
        members: draft.members.map((member) => ({
          name: member.name,
          ...(member.role ? { role: member.role } : {}),
          ...(member.provider && member.model ? { provider: member.provider, model: member.model } : {}),
          ...(member.reasoningEffort ? { reasoningEffort: member.reasoningEffort } : {}),
        })),
        ...(draft.tasks.length === 0 ? {} : { tasks: draft.tasks }),
      };
      return (
        "请调用 create_team 创建团队，然后简要汇报成员和任务：\n```json\n" +
        JSON.stringify(payload, null, 2) +
        "\n```"
      );
    }

    /** Flatten one model-catalog response into `provider/model` route rows. */
    function flattenCatalog(value) {
      const routes = [];
      for (const group of (value && value.groups) || []) {
        for (const model of group.models || []) {
          routes.push({
            provider: group.id,
            model: model.id,
            name: model.name || model.id,
            efforts: ((model.reasoning && model.reasoning.efforts) || []).map((effort) => effort.id),
            defaultEffort: (model.reasoning && model.reasoning.defaultEffort) || null,
          });
        }
      }
      return routes;
    }

    /** Efforts offered for one `provider::model` route. */
    function effortsOf(routes, provider, model) {
      const route = routes.find((entry) => entry.provider === provider && entry.model === model);
      return route ? route.efforts : [];
    }

    /** The draft editor: name, goal, editable member rows, and the create action. */
    function TeamWizard({ data, draft, setDraft, onCancel, onCreate, routes }) {
      const roles = data.roles || [];
      const templates = data.templates || [];
      const template = templates.find((entry) => entry.id === draft.templateId);

      const pickTemplate = (id) => {
        const found = templates.find((entry) => entry.id === id);
        setDraft({
          ...draft,
          templateId: id,
          name: found ? found.name : draft.name,
          members: found ? found.members.map((member) => ({ name: member.name, role: member.role })) : draft.members,
          tasks: found ? found.tasks.map((task) => ({ subject: task.subject, owner: task.owner, blocked_by: [] })) : [],
        });
      };

      const updateMember = (index, patch) => {
        const members = draft.members.map((member, position) => (position === index ? { ...member, ...patch } : member));
        setDraft({ ...draft, members });
      };

      const addMember = () => {
        const role = roles[0] ? roles[0].id : null;
        const used = new Set(draft.members.map((member) => member.name));
        let index = draft.members.length + 1;
        while (used.has("member-" + index)) index += 1;
        setDraft({ ...draft, members: [...draft.members, { name: "member-" + index, role }] });
      };

      return h(
        "div",
        { style: { padding: "12px 14px", overflow: "auto", height: "100%" } },
        h("div", { style: { fontSize: 13, fontWeight: 600, marginBottom: 10 } }, "新建团队"),
        h(
          "div",
          { style: { display: "grid", gap: 8 } },
          h(
            "label",
            { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary, #999)" } },
            "模板",
            h(
              "select",
              {
                value: draft.templateId || "",
                onChange: (event) => pickTemplate(event.target.value),
                style: { ...field, display: "block", width: "100%", marginTop: 4 },
              },
              h("option", { value: "" }, "空白团队"),
              templates.map((entry) => h("option", { key: entry.id, value: entry.id }, entry.name + " — " + (entry.description || ""))),
            ),
          ),
          h(
            "label",
            { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary, #999)" } },
            "团队名",
            h("input", {
              value: draft.name,
              onChange: (event) => setDraft({ ...draft, name: event.target.value }),
              style: { ...field, display: "block", width: "100%", marginTop: 4 },
            }),
          ),
          h(
            "label",
            { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary, #999)" } },
            "目标（可选）",
            h("input", {
              value: draft.goal,
              onChange: (event) => setDraft({ ...draft, goal: event.target.value }),
              placeholder: template ? template.description || "" : "",
              style: { ...field, display: "block", width: "100%", marginTop: 4 },
            }),
          ),
        ),
        section("团队 Lead"),
        h(
          "div",
          { style: { display: "grid", gridTemplateColumns: "1fr 110px", gap: 6 } },
          h(
            "select",
            {
              value: draft.leadProvider && draft.leadModel ? draft.leadProvider + "::" + draft.leadModel : "",
              onChange: (event) => {
                const value = event.target.value;
                if (value === "") return setDraft({ ...draft, leadProvider: null, leadModel: null, leadEffort: null });
                const separator = value.indexOf("::");
                const route = routes.find((entry) => entry.provider + "::" + entry.model === value);
                setDraft({
                  ...draft,
                  leadProvider: value.slice(0, separator),
                  leadModel: value.slice(separator + 2),
                  leadEffort: (route && route.defaultEffort) || null,
                });
              },
              style: field,
            },
            h("option", { value: "" }, "本会话作为 Lead（不单独创建）"),
            routes.map((route) =>
              h(
                "option",
                { key: "lead-" + route.provider + "::" + route.model, value: route.provider + "::" + route.model },
                "独立 Lead · " + route.provider + " / " + route.name,
              ),
            ),
          ),
          h(
            "select",
            {
              value: draft.leadEffort || "",
              disabled: effortsOf(routes, draft.leadProvider, draft.leadModel).length === 0,
              onChange: (event) => setDraft({ ...draft, leadEffort: event.target.value || null }),
              title: "Lead 推理强度",
              style: field,
            },
            h("option", { value: "" }, "effort：默认"),
            effortsOf(routes, draft.leadProvider, draft.leadModel).map((effort) =>
              h("option", { key: "lead-eff-" + effort, value: effort }, effort),
            ),
          ),
        ),
        section(
          "成员 (" + draft.members.length + ")",
          h("button", { type: "button", onClick: addMember, style: ghostButton }, "＋ 添加成员"),
        ),
        h(
          "div",
          { style: { display: "grid", gap: 6 } },
          draft.members.length === 0
            ? h("div", { style: { color: "#888", fontSize: 12 } }, "还没有成员")
            : draft.members.map((member, index) =>
                h(
                  "div",
                  { key: "m" + index, style: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr 90px auto", gap: 6 } },
                  h("input", {
                    value: member.name,
                    onChange: (event) => updateMember(index, { name: event.target.value }),
                    style: field,
                  }),
                  h(
                    "select",
                    {
                      value: member.role || "",
                      onChange: (event) => updateMember(index, { role: event.target.value || null }),
                      style: field,
                    },
                    h("option", { value: "" }, "（无角色）"),
                    roles.map((role) =>
                      h("option", { key: role.id, value: role.id }, role.id + " · " + (role.model || "inherit")),
                    ),
                  ),
                  h(
                    "select",
                    {
                      value: member.model ? member.provider + "::" + member.model : "",
                      onChange: (event) => {
                        const value = event.target.value;
                        if (value === "") return updateMember(index, { provider: null, model: null, reasoningEffort: null });
                        const separator = value.indexOf("::");
                        const route = routes.find(
                          (entry) => entry.provider + "::" + entry.model === value,
                        );
                        updateMember(index, {
                          provider: value.slice(0, separator),
                          model: value.slice(separator + 2),
                          reasoningEffort: (route && route.defaultEffort) || null,
                        });
                      },
                      title: "模型（覆盖角色默认）",
                      style: field,
                    },
                    h("option", { value: "" }, "模型：角色默认"),
                    routes.map((route) =>
                      h("option", { key: route.provider + "::" + route.model, value: route.provider + "::" + route.model }, route.provider + " / " + route.name),
                    ),
                  ),
                  h(
                    "select",
                    {
                      value: member.reasoningEffort || "",
                      disabled: effortsOf(routes, member.provider, member.model).length === 0,
                      onChange: (event) => updateMember(index, { reasoningEffort: event.target.value || null }),
                      title: "推理强度",
                      style: field,
                    },
                    h("option", { value: "" }, "effort：默认"),
                    effortsOf(routes, member.provider, member.model).map((effort) =>
                      h("option", { key: "eff-" + effort, value: effort }, effort),
                    ),
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      onClick: () => setDraft({ ...draft, members: draft.members.filter((_, position) => position !== index) }),
                      style: ghostButton,
                    },
                    "删除",
                  ),
                ),
              ),
        ),
        draft.tasks.length > 0
          ? h(
              "div",
              null,
              section("任务草案 (" + draft.tasks.length + ")"),
              table(
                ["#", "subject", "owner"],
                draft.tasks.map((task, index) => [index + 1, task.subject, task.owner || ""]),
              ),
            )
          : null,
        h(
          "div",
          { style: { display: "flex", gap: 8, marginTop: 16 } },
          h("button", { type: "button", onClick: onCreate, style: primaryButton }, "创建团队"),
          h("button", { type: "button", onClick: onCancel, style: ghostButton }, "取消"),
        ),
        h(
          "div",
          { style: { marginTop: 10, fontSize: 11, color: "var(--dsw-alias-label-tertiary, #999)" } },
          "创建会向 Lead 发送一条指令，由它调用 create_team 完成实例化。",
        ),
      );
    }

    /** The right-hand tab body: Team switcher, roster, board, and the wizard. */
    function TeamTabBody({ sessionId, useSessions, inputActions, loadRoutes }) {
      const data = useSessions((state) => state.projectionsBySession[sessionId]?.values.enterpriseTeam) || {};
      const teams = data.teams || [];
      const [selectedId, setSelectedId] = react.useState(null);
      const [draft, setDraft] = react.useState(null);
      const [goalDraft, setGoalDraft] = react.useState("");
      const [routes, setRoutes] = react.useState([]);
      react.useEffect(() => {
        if (typeof loadRoutes !== "function") return;
        let live = true;
        loadRoutes().then(
          (response) => {
            if (live && response && response.ok) setRoutes(flattenCatalog(response.value));
          },
          () => {},
        );
        return () => {
          live = false;
        };
      }, [loadRoutes]);

      const selected =
        teams.find((team) => team.id === selectedId) || teams.find((team) => team.status === "active") || teams[0];

      const startWizard = () =>
        setDraft({
          templateId: null,
          name: "",
          goal: "",
          members: [],
          tasks: [],
          leadProvider: null,
          leadModel: null,
          leadEffort: null,
        });

      const create = () => {
        if (draft === null) return;
        const instruction = createInstruction(draft);
        if (inputActions && typeof inputActions.insertText === "function") inputActions.insertText(instruction);
        setDraft(null);
      };

      if (draft !== null) {
        return h(TeamWizard, {
          data,
          draft,
          setDraft,
          routes,
          onCancel: () => setDraft(null),
          onCreate: create,
        });
      }

      if (teams.length === 0) {
        return h(
          "div",
          { style: { padding: "16px 14px" } },
          h("div", { style: { fontSize: 13, fontWeight: 600 } }, "还没有团队"),
          h(
            "div",
            { style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary, #999)", margin: "6px 0 14px" } },
            "从一个模板开始，或让 Lead 按目标组队。",
          ),
          h("button", { type: "button", onClick: startWizard, style: primaryButton }, "从模板创建"),
          h(
            "div",
            { style: { display: "flex", gap: 8, marginTop: 12 } },
            h("input", {
              value: goalDraft,
              placeholder: "描述目标，让模型先出团队草案…",
              onChange: (event) => setGoalDraft(event.target.value),
              style: { ...field, flex: 1 },
            }),
            h(
              "button",
              {
                type: "button",
                style: ghostButton,
                onClick: () => {
                  const goal = goalDraft.trim();
                  if (goal === "") return;
                  send(
                    "请调用 plan_team 规划一个团队，目标：" +
                      goal +
                      "。要求：成员只用角色目录中的角色；每条任务必须有 acceptance；阶段之间用 blocked_by 串行；高风险位置用高能力模型，机械任务用 deepseek-flash；人数默认不超过 5。规划完把草案留给我审核，不要直接 create_team。",
                  );
                  setGoalDraft("");
                },
              },
              "生成草案",
            ),
          ),
        );
      }

      const members = selected ? selected.members || [] : [];
      const allTasks = selected ? selected.tasks || [] : [];
      const inMotion = allTasks.filter((task) => task.status === "pending" || task.status === "in_progress");
      const reviewing = allTasks.filter((task) => task.status === "review");
      const abandonedCount = allTasks.filter((task) => task.status === "abandoned").length;
      const completedCount = allTasks.filter((task) => task.status === "completed").length;
      const send = (instruction) => {
        if (inputActions && typeof inputActions.insertText === "function") inputActions.insertText(instruction);
      };
      const teammates = members.filter((member) => member.role !== "lead");

      const drafts = data.drafts || [];

      return h(
        "div",
        { style: { padding: "12px 14px", overflow: "auto", height: "100%" } },
        drafts.length === 0
          ? null
          : h(
              "div",
              { style: { marginBottom: 14 } },
              section("待审核草案 (" + drafts.length + ")"),
              drafts.map((draft) =>
                h(
                  "div",
                  {
                    key: "draft-" + draft.id,
                    style: {
                      border: "1px solid var(--dsw-alias-border-strong, #3a3a3a)",
                      borderRadius: 8,
                      padding: "10px 12px",
                      marginBottom: 10,
                    },
                  },
                  h("div", { style: { fontSize: 12, fontWeight: 600 } }, draft.name + " · " + draft.goal),
                  h(
                    "div",
                    { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary, #999)", marginTop: 3 } },
                    draft.lead
                      ? "Lead：" + (draft.lead.role || "继承") + " · " + (draft.lead.model || "inherit") + (draft.lead.effort ? " · " + draft.lead.effort : "")
                      : "Lead：本会话",
                  ),
                  draft.notes
                    ? h("div", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary, #999)", margin: "4px 0" } }, draft.notes)
                    : null,
                  table(
                    ["member", "role", "model", "effort"],
                    (draft.members || []).map((member) => [member.name, member.role || "", member.model || "", member.effort || "—"]),
                  ),
                  table(
                    ["#", "task", "owner", "blocked by", "acceptance"],
                    (draft.tasks || []).map((task, index) => [
                      index + 1,
                      task.subject,
                      task.owner || "",
                      (task.blocked_by || []).join(","),
                      task.acceptance,
                    ]),
                  ),
                  h(
                    "div",
                    { style: { display: "flex", gap: 8, marginTop: 8 } },
                    h(
                      "button",
                      {
                        type: "button",
                        style: primaryButton,
                        onClick: () =>
                          send(
                            "请调用 create_team({ draft_id: \"" +
                              draft.id +
                              "\" }) 实例化这个草案，然后汇报成员与任务板；不要开始执行任务。",
                          ),
                      },
                      "确认创建",
                    ),
                    h(
                      "button",
                      {
                        type: "button",
                        style: ghostButton,
                        onClick: () =>
                          send(
                            "请基于草案 " + draft.id + " 重新规划（目标：" + draft.goal + "），调整后给出新草案供审核，不要直接创建。",
                          ),
                      },
                      "重新规划",
                    ),
                    h(
                      "button",
                      {
                        type: "button",
                        style: ghostButton,
                        onClick: () => send("请调用 discard_draft({ draft_id: \"" + draft.id + "\" }) 丢弃这个草案。"),
                      },
                      "丢弃",
                    ),
                  ),
                ),
              ),
            ),
        h(
          "div",
          { style: { display: "flex", gap: 8, alignItems: "center" } },
          h(
            "select",
            {
              value: selected ? selected.id : "",
              onChange: (event) => setSelectedId(event.target.value),
              style: { ...field, flex: 1 },
            },
            teams.map((team) =>
              h("option", { key: team.id, value: team.id }, team.name + (team.status === "archived" ? "（已归档）" : "")),
            ),
          ),
          h("button", { type: "button", onClick: startWizard, style: ghostButton }, "＋ 新建团队"),
        ),
        selected && selected.goal
          ? h("div", { style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary, #999)", marginTop: 8 } }, selected.goal)
          : null,
        h(
          "div",
          { style: { display: "flex", gap: 8, marginTop: 10 } },
          h("input", {
            value: goalDraft,
            placeholder: "给这个团队一个新目标…",
            onChange: (event) => setGoalDraft(event.target.value),
            style: { ...field, flex: 1 },
          }),
          h(
            "button",
            {
              type: "button",
              onClick: () => {
                if (goalDraft.trim() === "" || selected === undefined) return;
                const instruction =
                  "请调用 assign_goal 给团队 \"" +
                  selected.name +
                  "\" 设置新目标，并给出任务拆分后创建任务板：\n" +
                  goalDraft.trim() +
                  "\n（旧目标的未完成任务会被标记为 abandoned）";
                if (inputActions && typeof inputActions.insertText === "function") inputActions.insertText(instruction);
                setGoalDraft("");
              },
              style: primaryButton,
            },
            "换目标",
          ),
        ),
        section("Members (" + teammates.length + ")"),
        table(
          ["member", "role", "model", "effort", "context", "status"],
          members.map((member) => [
            member.name,
            member.role,
            member.model,
            member.effort || "—",
            member.context,
            member.status || member.phase,
          ]),
        ),
        section("Token 用量（role × model）"),
        (() => {
          const rowsByKey = new Map();
          let teamTotal = { input: 0, output: 0, cached: 0, total: 0 };
          for (const member of members) {
            const usage = member.usage;
            if (!usage) continue;
            const role = member.role || "member";
            const model = usage.model || member.model || "unknown";
            const key = role + "|" + model;
            const row = rowsByKey.get(key) || { role, model, count: 0, input: 0, output: 0, cached: 0, total: 0 };
            row.count += 1;
            row.input += usage.input || 0;
            row.output += usage.output || 0;
            row.cached += usage.cached || 0;
            row.total += usage.total || 0;
            rowsByKey.set(key, row);
            teamTotal.input += usage.input || 0;
            teamTotal.output += usage.output || 0;
            teamTotal.cached += usage.cached || 0;
            teamTotal.total += usage.total || 0;
          }
          const rows = [...rowsByKey.values()].sort((a, b) => b.total - a.total);
          if (rows.length === 0) {
            return h("div", { style: { color: "#888", fontSize: 12 } }, "暂无用量（成员会话未加载或尚未产生请求）");
          }
          const body = rows.map((row) => [row.role, row.model, row.count, row.input, row.output, row.cached, row.total]);
          body.push(["合计", "", rows.reduce((sum, row) => sum + row.count, 0), teamTotal.input, teamTotal.output, teamTotal.cached, teamTotal.total]);
          return table(["role", "model", "成员", "input", "output", "cached", "total"], body);
        })(),
        section(
          "待认领 / 进行中 (" + inMotion.length + ")",
          abandonedCount === 0 ? null : h("span", { style: { fontSize: 11, color: "#888" } }, abandonedCount + " abandoned"),
        ),
        table(
          ["id", "status", "owner", "subject", "blocked by", "scopes"],
          inMotion.map((task) => [
            task.id,
            task.status,
            task.owner || "",
            task.subject,
            (task.blockedBy || []).join(","),
            (task.writeScopes || []).join(","),
          ]),
        ),
        section("待验收 (" + reviewing.length + ")"),
        reviewing.length === 0
          ? h("div", { style: { color: "#888", fontSize: 12 } }, "没有待验收任务")
          : reviewing.map((task) =>
              h(
                "div",
                { key: "rv" + task.id, style: { borderTop: "1px solid var(--dsw-alias-border-subtle, #333)", padding: "6px 0" } },
                h(
                  "div",
                  { style: { fontSize: 12, fontWeight: 600 } },
                  "#" + task.id + " " + task.subject + (task.owner ? " · " + task.owner : ""),
                ),
                h(
                  "div",
                  { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary, #999)", margin: "3px 0" } },
                  "证据：" + (task.evidence || "（未填写）") + (task.submittedBy ? "  ·  提交人：" + task.submittedBy : ""),
                ),
                h(
                  "div",
                  { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary, #999)" } },
                  "验收人：" + (task.reviewer || "团队 reviewer / Lead"),
                ),
                task.acceptance
                  ? h("div", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary, #999)" } }, "验收标准：" + task.acceptance)
                  : null,
                h(
                  "div",
                  { style: { display: "flex", gap: 8, marginTop: 6 } },
                  h(
                    "button",
                    {
                      type: "button",
                      style: primaryButton,
                      onClick: () =>
                        send(
                          "请调用 task_update 通过验收：{ \"team\": \"" +
                            selected.name +
                            "\", \"id\": " +
                            task.id +
                            ", \"revision\": " +
                            task.revision +
                            ", \"action\": \"accept\" }",
                        ),
                    },
                    "通过",
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      style: ghostButton,
                      onClick: () =>
                        send(
                          "请调用 task_update 打回验收：{ \"team\": \"" +
                            selected.name +
                            "\", \"id\": " +
                            task.id +
                            ", \"revision\": " +
                            task.revision +
                            ", \"action\": \"reject\", \"note\": \"<填写打回原因>\" }",
                        ),
                    },
                    "打回",
                  ),
                ),
              ),
            ),
        section("已完成 / 已放弃 (" + (completedCount + abandonedCount) + ")"),
      );
    }

    /** Conversation-header shortcut that opens the right-hand Team tab. */
    function TeamHeaderAction({ sessionId, useSessions, openTeam }) {
      const data = useSessions((state) => state.projectionsBySession[sessionId]?.values.enterpriseTeam) || {};
      const teams = data.teams || [];
      const count = teams.reduce(
        (sum, team) => sum + ((team.members || []).filter((member) => member.role !== "lead").length || 0),
        0,
      );
      return h(
        "button",
        {
          type: "button",
          onClick: () => openTeam(),
          title: "Open the Enterprise Team tab",
          style: {
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            minHeight: 28,
            padding: "3px 8px",
            border: 0,
            borderRadius: 6,
            background: "transparent",
            color: "var(--dsw-alias-label-tertiary, #999)",
            fontSize: 12,
            cursor: "pointer",
          },
        },
        "Team",
        h(
          "span",
          { style: { fontVariantNumeric: "tabular-nums", color: "var(--dsw-alias-label-caption, #777)" } },
          String(count),
        ),
      );
    }

    /** Client plugin body: tab type, tab body, and the header shortcut. */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "enterprise-team: dictionaries");

      ctx.effect(
        () =>
          ctx.sidebarRightTabs.register({
            id: KIND,
            kind: KIND,
            priority: "builtin",
            title: () => en.title,
            guide: [
              {
                id: "team",
                order: 25,
                title: () => en.title,
                description: () => "Teams, members, models, and the shared task board",
              },
            ],
          }),
        "enterprise-team: tab type",
      );

      ctx.effect(
        () =>
          ctx.slots.inject(BODY_SLOT, () =>
            ctx.slots.register(
              {
                name: BODY_SLOT,
                key: KIND,
                locale: NS,
                inject: () => ({ loadRoutes: () => ctx.remote.session.modelCatalog() }),
              },
              TeamTabBody,
            ),
          ),
        "enterprise-team: tab body",
      );

      ctx.effect(
        () =>
          ctx.slots.inject(HEADER_SLOT, () =>
            ctx.slots.register(
              {
                name: HEADER_SLOT,
                id: "enterprise-team",
                order: -10,
                locale: NS,
                inject: () => ({ openTeam: () => ctx.sidebarRight.openTab(KIND) }),
              },
              TeamHeaderAction,
            ),
          ),
        "enterprise-team: header shortcut",
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
