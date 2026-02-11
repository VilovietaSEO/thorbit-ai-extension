/**
 * Popup Script - AI Assistant Tasks
 *
 * Quick task management from Chrome toolbar popup.
 * Syncs with chrome.storage.local for persistence.
 *
 * Features:
 * - Add/remove tasks
 * - Toggle task completion status
 * - Clear completed tasks
 * - Open side panel for AI assistance
 *
 * @requires Chrome Extension APIs (chrome.storage, chrome.sidePanel)
 */

// ============================================
// DOM ELEMENTS
// ============================================

const taskList = document.getElementById('task-list');
const emptyState = document.getElementById('empty-state');
const newTaskInput = document.getElementById('new-task-input');
const addTaskBtn = document.getElementById('add-task-btn');
const openPanelBtn = document.getElementById('open-panel-btn');
const clearCompletedBtn = document.getElementById('clear-completed-btn');
const taskCountEl = document.getElementById('task-count');

// ============================================
// STATE
// ============================================

/** @type {Array<{id: string, text: string, completed: boolean, createdAt: number}>} */
let tasks = [];

// ============================================
// STORAGE
// ============================================

/**
 * Load tasks from chrome.storage.local
 * @returns {Promise<void>}
 */
async function loadTasks() {
  try {
    const result = await chrome.storage.local.get(['tasks']);
    tasks = result.tasks || [];
    renderTasks();
  } catch (error) {
    console.error('[Popup] Failed to load tasks:', error);
    tasks = [];
    renderTasks();
  }
}

/**
 * Save tasks to chrome.storage.local
 * @returns {Promise<void>}
 */
async function saveTasks() {
  try {
    await chrome.storage.local.set({ tasks });
  } catch (error) {
    console.error('[Popup] Failed to save tasks:', error);
  }
}

// ============================================
// TASK OPERATIONS
// ============================================

/**
 * Generate a unique task ID
 * @returns {string}
 */
function generateId() {
  return `task_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Add a new task
 * @param {string} text - Task text
 */
function addTask(text) {
  const trimmedText = text.trim();
  if (!trimmedText) return;

  const newTask = {
    id: generateId(),
    text: trimmedText,
    completed: false,
    createdAt: Date.now(),
  };

  tasks.unshift(newTask);
  saveTasks();
  renderTasks();
  newTaskInput.value = '';
  newTaskInput.focus();
}

/**
 * Toggle task completion status
 * @param {string} taskId - Task ID
 */
function toggleTask(taskId) {
  const task = tasks.find((t) => t.id === taskId);
  if (task) {
    task.completed = !task.completed;
    saveTasks();
    renderTasks();
  }
}

/**
 * Delete a task with animation
 * @param {string} taskId - Task ID
 */
function deleteTask(taskId) {
  const taskEl = document.querySelector(`[data-task-id="${taskId}"]`);
  if (taskEl) {
    taskEl.classList.add('removing');
    taskEl.addEventListener('animationend', () => {
      tasks = tasks.filter((t) => t.id !== taskId);
      saveTasks();
      renderTasks();
    }, { once: true });
  } else {
    tasks = tasks.filter((t) => t.id !== taskId);
    saveTasks();
    renderTasks();
  }
}

/**
 * Clear all completed tasks
 */
function clearCompleted() {
  const completedTasks = tasks.filter((t) => t.completed);
  if (completedTasks.length === 0) return;

  // Animate removal
  completedTasks.forEach((task) => {
    const taskEl = document.querySelector(`[data-task-id="${task.id}"]`);
    if (taskEl) {
      taskEl.classList.add('removing');
    }
  });

  // Wait for animations then update
  setTimeout(() => {
    tasks = tasks.filter((t) => !t.completed);
    saveTasks();
    renderTasks();
  }, 200);
}

// ============================================
// RENDERING
// ============================================

/**
 * Render the task list
 */
function renderTasks() {
  // Clear current list
  taskList.innerHTML = '';

  // Update empty state visibility
  emptyState.hidden = tasks.length > 0;
  taskList.style.display = tasks.length > 0 ? 'block' : 'none';

  // Render tasks
  tasks.forEach((task) => {
    const taskEl = createTaskElement(task);
    taskList.appendChild(taskEl);
  });

  // Update footer
  updateFooter();
}

/**
 * Create a task element
 * @param {{id: string, text: string, completed: boolean}} task
 * @returns {HTMLElement}
 */
function createTaskElement(task) {
  const div = document.createElement('div');
  div.className = `task-item${task.completed ? ' completed' : ''}`;
  div.setAttribute('data-task-id', task.id);

  div.innerHTML = `
    <label class="task-checkbox">
      <input type="checkbox" ${task.completed ? 'checked' : ''} aria-label="Toggle task completion">
      <span class="checkmark"></span>
    </label>
    <span class="task-text">${escapeHtml(task.text)}</span>
    <button type="button" class="task-delete" aria-label="Delete task" title="Delete task">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="18" y1="6" x2="6" y2="18"/>
        <line x1="6" y1="6" x2="18" y2="18"/>
      </svg>
    </button>
  `;

  // Event listeners
  const checkbox = div.querySelector('input[type="checkbox"]');
  checkbox.addEventListener('change', () => toggleTask(task.id));

  const deleteBtn = div.querySelector('.task-delete');
  deleteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteTask(task.id);
  });

  return div;
}

/**
 * Update footer with task count and clear button state
 */
function updateFooter() {
  const total = tasks.length;
  const completed = tasks.filter((t) => t.completed).length;
  const pending = total - completed;

  // Update count text
  if (total === 0) {
    taskCountEl.textContent = '0 tasks';
  } else if (completed === 0) {
    taskCountEl.textContent = `${total} task${total !== 1 ? 's' : ''}`;
  } else {
    taskCountEl.textContent = `${pending} of ${total} remaining`;
  }

  // Update clear button state
  clearCompletedBtn.disabled = completed === 0;
}

/**
 * Escape HTML to prevent XSS
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ============================================
// SIDE PANEL
// ============================================

/**
 * Open the side panel
 */
async function openSidePanel() {
  try {
    // Get the current tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (tab?.id) {
      // Open side panel for this tab
      await chrome.sidePanel.open({ tabId: tab.id });
      // Close popup after opening side panel
      window.close();
    }
  } catch (error) {
    console.error('[Popup] Failed to open side panel:', error);
  }
}

// ============================================
// EVENT LISTENERS
// ============================================

// Add task on button click
addTaskBtn.addEventListener('click', () => {
  addTask(newTaskInput.value);
});

// Add task on Enter key
newTaskInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    addTask(newTaskInput.value);
  }
});

// Clear completed tasks
clearCompletedBtn.addEventListener('click', clearCompleted);

// Open side panel
openPanelBtn.addEventListener('click', openSidePanel);

// Listen for storage changes from other contexts
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local' && changes.tasks) {
    tasks = changes.tasks.newValue || [];
    renderTasks();
  }
});

// ============================================
// INITIALIZATION
// ============================================

// Load tasks on popup open
document.addEventListener('DOMContentLoaded', () => {
  loadTasks();
  // Focus input for quick task entry
  newTaskInput.focus();
});
