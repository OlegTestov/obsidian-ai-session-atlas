"""Строка состояния из репозитория (для разработки); сам код — atlas/statusline.py."""
import os
import runpy

runpy.run_path(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                            "atlas", "statusline.py"), run_name="__main__")
