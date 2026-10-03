"""Status line run from the repository (for development); the code itself is atlas/statusline.py."""
import os
import runpy

runpy.run_path(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                            "atlas", "statusline.py"), run_name="__main__")
