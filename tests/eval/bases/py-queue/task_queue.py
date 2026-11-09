class PriorityTaskQueue:
    def __init__(self):
        self._tasks = []

    def push(self, task_id, priority=0, payload=None):
        if not isinstance(task_id, str) or not task_id:
            raise ValueError("task_id must be a non-empty string")
        item = {
            "id": task_id,
            "priority": int(priority),
            "payload": payload,
            "status": "pending",
            "attempts": 0
        }
        self._tasks.append(item)
        self._tasks.sort(key=lambda x: x["priority"], reverse=True)

    def pop(self):
        for task in self._tasks:
            if task["status"] == "pending":
                task["status"] = "in_progress"
                task["attempts"] += 1
                return task
        return None

    def complete(self, task_id):
        for task in self._tasks:
            if task["id"] == task_id:
                task["status"] = "completed"
                return True
        return False

    def fail(self, task_id, max_retries=3):
        for task in self._tasks:
            if task["id"] == task_id:
                if task["attempts"] >= max_retries:
                    task["status"] = "dead_letter"
                else:
                    task["status"] = "pending"
                return True
        return False

    def size(self):
        return len(self._tasks)

    def pending_count(self):
        return sum(1 for task in self._tasks if task["status"] == "pending")
