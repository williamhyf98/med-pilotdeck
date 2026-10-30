import asyncio
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from server import app
from server.path_safety import ACCESS_DENIED, assert_input_tree_in_user_home, assert_path_in_user_home


class UserPathSafetyTests(unittest.TestCase):
    def test_current_user_only_and_missing_targets(self):
        with tempfile.TemporaryDirectory() as root:
            home = Path(root) / "users" / "2"
            other = Path(root) / "users" / "3"
            home.mkdir(parents=True)
            other.mkdir()
            own_file = home / "own.txt"
            own_file.write_text("ok")
            secret = other / "secret.txt"
            secret.write_text("private")
            (home / "escape").symlink_to(other, target_is_directory=True)
            with patch.dict(os.environ, {"PILOT_HOME": str(home), "PILOTDECK_DISABLE_LOCAL_AUTH": "0"}):
                self.assertEqual(assert_path_in_user_home(str(own_file)), own_file.resolve())
                self.assertEqual(assert_path_in_user_home(str(home / "new" / "file")), (home / "new" / "file").resolve())
                for path in (str(secret), str(home / ".." / "3" / "secret.txt"),
                             str(home / "escape" / "secret.txt"), str(other / "new" / "file")):
                    with self.subTest(path=path), self.assertRaisesRegex(PermissionError, "访问被禁止") as ctx:
                        assert_path_in_user_home(path)
                    self.assertEqual(str(ctx.exception), ACCESS_DENIED)
                    self.assertNotIn(str(other), str(ctx.exception))
                with self.assertRaises(PermissionError):
                    assert_input_tree_in_user_home(str(home))

    def test_no_home_in_multiuser_mode_fails_closed_but_local_mode_preserved(self):
        with patch.dict(os.environ, {"PILOTDECK_DISABLE_LOCAL_AUTH": "false"}, clear=True):
            with self.assertRaises(PermissionError):
                assert_path_in_user_home("/tmp/example")
        with patch.dict(os.environ, {"PILOTDECK_DISABLE_LOCAL_AUTH": "true"}, clear=True):
            self.assertEqual(assert_path_in_user_home("/tmp/example"), Path("/tmp/example").resolve())

    def test_medical_route_and_mixed_image_list_are_blocked_before_processing(self):
        with tempfile.TemporaryDirectory() as root:
            home = Path(root) / "users" / "2"
            other = Path(root) / "users" / "3"
            home.mkdir(parents=True)
            other.mkdir()
            image = home / "a.png"
            image.write_bytes(b"fake")
            outside = other / "b.png"
            outside.write_bytes(b"fake")
            with patch.dict(os.environ, {"PILOT_HOME": str(home), "PILOTDECK_DISABLE_LOCAL_AUTH": "0"}):
                for call in (lambda: app.med_image_route(str(outside)), lambda: app.med_dicom_route(str(outside))):
                    with self.assertRaises(PermissionError):
                        call()

                async def check():
                    with self.assertRaises(PermissionError):
                        await app.med_trauma_stage_plan("手术组", "测试", None, [str(image), str(outside)])
                    with self.assertRaises(PermissionError):
                        await app.med_parse_medical(str(outside), None, skip_vlm=True)
                    with self.assertRaises(PermissionError):
                        await app.med_deepchest_submit(str(outside), "测试", "chest", "CT", "HU")

                asyncio.run(check())
