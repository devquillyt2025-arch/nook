/**
 * aiContext.js
 * 
 * Aggregates user data from localStorage into a compact context string
 * for the AI Assistant. This allows the LLM to answer questions about
 * the user's tasks, habits, calendar, and notes without a backend.
 */

export function buildAiContext() {
  const context = [];
  
  // 1. Current Date & Time
  const now = new Date();
  context.push(`Current Date and Time: ${now.toLocaleString()}`);

  // 2. Tasks
  try {
    const tasksRaw = localStorage.getItem('nook-tasks');
    if (tasksRaw) {
      const tasks = JSON.parse(tasksRaw);
      const pendingTasks = tasks.filter(t => !t.completed);
      const completedToday = tasks.filter(t => {
        if (!t.completed || !t.completedAt) return false;
        return new Date(t.completedAt).toDateString() === now.toDateString();
      });

      context.push('\n--- Tasks ---');
      context.push(`Pending Tasks (${pendingTasks.length}):`);
      pendingTasks.slice(0, 50).forEach(t => { // limit to 50 to save tokens
        let taskStr = `- ${t.name || t.title || t.text}`;
        if (t.dueDate) taskStr += ` (Due: ${t.dueDate})`;
        if (t.categoryId) taskStr += ` [Category: ${t.categoryId}]`;
        context.push(taskStr);
      });
      if (pendingTasks.length > 50) context.push(`... and ${pendingTasks.length - 50} more.`);

      context.push(`\nTasks Completed Today: ${completedToday.length}`);
    }
  } catch (e) {
    console.error('Failed to parse tasks for AI context', e);
  }

  // 3. Habits
  try {
    const habitsRaw = localStorage.getItem('nook_habits');
    if (habitsRaw) {
      const habits = JSON.parse(habitsRaw);
      context.push('\n--- Habits ---');
      habits.forEach(h => {
        context.push(`- ${h.title} (Active: ${h.archived ? 'No' : 'Yes'})`);
      });
    }
  } catch (e) {
    console.error('Failed to parse habits for AI context', e);
  }

  // 4. Intentions (Today)
  try {
    const intentionsRaw = localStorage.getItem('nook-intentions');
    if (intentionsRaw) {
      const intentions = JSON.parse(intentionsRaw);
      const todayStr = now.toISOString().slice(0, 10);
      if (intentions[todayStr]) {
        context.push('\n--- Today\'s Intentions ---');
        intentions[todayStr].forEach(i => context.push(`- ${i.text}`));
      }
    }
  } catch (e) {
    console.error('Failed to parse intentions for AI context', e);
  }

  // 5. Goals
  try {
    const goalsRaw = localStorage.getItem('nook_goals');
    if (goalsRaw) {
      const goals = JSON.parse(goalsRaw);
      context.push('\n--- Goals ---');
      goals.forEach(g => {
        if (!g.completedAt) {
          context.push(`- ${g.title} (Target: ${g.targetDate || 'None'})`);
        }
      });
    }
  } catch (e) {
    console.error('Failed to parse goals for AI context', e);
  }

  return context.join('\n');
}
