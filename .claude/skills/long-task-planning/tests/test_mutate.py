import importlib
import unittest

import mutate


class MutantDefinitionTests(unittest.TestCase):
    def test_every_mutant_applies_to_its_target_exactly_once(self):
        stale = [f"{name}: {problem}" for name, replacements, _tests, target, _module in mutate.M
                 if (problem := mutate.mutated(replacements, target)[1])]
        self.assertEqual(stale, [])

    def test_every_mutant_names_tests_that_exist(self):
        missing = []
        for name, _replacements, tests, _target, module in mutate.M:
            loaded = importlib.import_module(module)
            for spec in tests:
                found = loaded
                for part in spec.split("."):
                    found = getattr(found, part, None)
                if found is None:
                    missing.append(f"{name}: {module}.{spec}")
        self.assertEqual(missing, [])


if __name__ == "__main__":
    unittest.main()
