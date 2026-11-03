import unittest
from task_queue import PriorityTaskQueue


class TestPriorityTaskQueue(unittest.TestCase):
    def test_priority_ordering(self):
        q = PriorityTaskQueue()
        q.push("low", priority=1)
        q.push("high", priority=10)
        q.push("medium", priority=5)

        task1 = q.pop()
        self.assertEqual(task1["id"], "high")
        task2 = q.pop()
        self.assertEqual(task2["id"], "medium")

    def test_complete_task(self):
        q = PriorityTaskQueue()
        q.push("t1", priority=1)
        q.pop()
        self.assertTrue(q.complete("t1"))
        self.assertFalse(q.complete("nonexistent"))

    def test_retry_and_dead_letter(self):
        q = PriorityTaskQueue()
        q.push("t1", priority=1)
        t = q.pop()
        self.assertEqual(t["attempts"], 1)

        q.fail("t1", max_retries=2)
        self.assertEqual(q.pending_count(), 1)

        t2 = q.pop()
        self.assertEqual(t2["attempts"], 2)
        q.fail("t1", max_retries=2)
        self.assertEqual(q.pending_count(), 0)

    def test_empty_pop(self):
        q = PriorityTaskQueue()
        self.assertIsNone(q.pop())

    def test_invalid_task_id(self):
        q = PriorityTaskQueue()
        with self.assertRaises(ValueError):
            q.push("", priority=1)


if __name__ == "__main__":
    unittest.main()
