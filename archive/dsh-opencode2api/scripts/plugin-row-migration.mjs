/** 只迁移本仓库拥有的顶层插件行，保留白名单、注释和原有换行。 */
export function migratePluginRows(text, plugins) {
  const lines = text.split('\n');
  const starts = lines.flatMap((line, index) => /^-\s/.test(line) ? [index] : []);
  const scalar = '[\'"]?([^\'"\\s#]+)[\'"]?\\s*(?:#.*)?\\r?$';
  const idPattern = new RegExp(`^(- |  )id:\\s*${scalar}`);
  const namePattern = new RegExp(`^(- |  )name:\\s*${scalar}`);
  const replaceValue = (line, key, value) => line.replace(
    new RegExp(`^((?:- |  )${key}:\\s*)(?:'[^']*'|"[^"]*"|[^\\s#]+)`),
    (_match, prefix) => prefix + value,
  );
  const rows = starts.map((start, index) => {
    const row = { start, end: starts[index + 1] ?? lines.length };
    for (let i = row.start; i < row.end; i++) {
      const id = idPattern.exec(lines[i]);
      const name = namePattern.exec(lines[i]);
      if (id) Object.assign(row, { id: id[2], idAt: i, idLead: id[1] });
      if (name) Object.assign(row, { name: name[2], nameAt: i, nameLead: name[1] });
    }
    return row;
  });
  const migrated = [];
  for (const row of rows) {
    const plugin = plugins.find((item) => item.rowId === row.id || item.legacyRowIds?.includes(row.id));
    if (!plugin || (row.name && row.name !== plugin.name && !plugin.legacy.includes(row.name))) continue;
    let changed = false;
    if (row.id !== plugin.rowId) {
      if (rows.some((other) => other !== row && other.id === plugin.rowId)) throw new Error(`配置里同时存在 ${row.id} 和 ${plugin.rowId}，请先合并两行配置`);
      lines[row.idAt] = replaceValue(lines[row.idAt], 'id', plugin.rowId);
      changed = true;
    }
    if (plugin.legacy.includes(row.name)) {
      lines[row.nameAt] = replaceValue(lines[row.nameAt], 'name', `'${plugin.name}'`);
      changed = true;
    }
    if (changed) migrated.push(plugin.rowId);
  }
  return { text: lines.join('\n'), migrated };
}
