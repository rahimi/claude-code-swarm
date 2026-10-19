# The sky renderer's motion, without a process: python3 -m unittest discover -s tests -p 'test_*.py'
import importlib.util, os, tempfile, unittest

spec = importlib.util.spec_from_file_location('sky', os.path.join(os.path.dirname(__file__), '..', 'hooks', 'sky.py'))
sky = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sky)

FLIGHT = 1000
LINE = {'a': [10, 10], 'q': [100, 40], 'b': [190, 10], 'stop': 1, 'start': 0}


class Motion(unittest.TestCase):
    def test_a_lit_edge_grows_behind_its_comet_half_way_at_mid_flight(self):
        self.assertAlmostEqual(sky.flown(0, FLIGHT / 2, FLIGHT), 0.5, places=6)
        ys, xs, cover, along = sky.stroke_mask(100, 200, [tuple(p) for p in sky.curve_points(LINE['a'], LINE['q'], LINE['b'])], 2.0)
        drawn = (along <= sky.flown(0, FLIGHT / 2, FLIGHT)).sum() / along.size
        self.assertGreater(drawn, 0.4)
        self.assertLess(drawn, 0.6)
        self.assertEqual(sky.flown(0, 0, FLIGHT), 0)
        self.assertEqual(sky.flown(0, FLIGHT, FLIGHT), 1)

    def test_a_held_comet_lands_at_its_stop_and_ripples_for_400_ms_a_delivered_one_reaches_the_centre_and_flares(self):
        held = dict(LINE, stop=0.8, held=True, lead=True)
        land = sky.arrival(held, FLIGHT)
        self.assertAlmostEqual(sky.ease((land - held['start']) / FLIGHT), 0.8, places=4)
        self.assertEqual(sky.ripple(held, land - 1, FLIGHT), 0)
        self.assertAlmostEqual(sky.ripple(held, land, FLIGHT), 1)
        self.assertEqual(sky.ripple(held, land + sky.RIPPLE_MS, FLIGHT), 0)
        self.assertEqual(sky.flare(held, land, FLIGHT), 0)
        delivered = dict(LINE, lead=True, held=False)
        self.assertAlmostEqual(sky.arrival(delivered, FLIGHT), FLIGHT, delta=1)
        x, y = sky.bez(delivered, min(delivered['stop'], sky.flown(0, FLIGHT, FLIGHT)))
        self.assertEqual((round(x), round(y)), (190, 10))
        self.assertAlmostEqual(sky.flare(delivered, FLIGHT, FLIGHT), 1, places=2)
        self.assertEqual(sky.flare(delivered, FLIGHT + sky.FLARE_MS, FLIGHT), 0)
        self.assertEqual(sky.ripple(delivered, FLIGHT, FLIGHT), 0)


class Count(unittest.TestCase):
    def test_the_wake_count_draws_in_the_pixel_font(self):
        f = sky.np.zeros((40, 60, 3), sky.np.float32)
        sky.digits(f, '18', 30, 20, 2, sky.rgb([255, 0, 0]))
        self.assertEqual(int((f[..., 0] > 0).sum()), (8 + 13) * 4)


class Leave(unittest.TestCase):
    def test_leave_removes_its_empty_folder_and_keeps_one_with_other_files(self):
        for extra, kept in ((None, False), ('other.txt', True)):
            sky.DIR = tempfile.mkdtemp()
            open(os.path.join(sky.DIR, 'scene.json'), 'w').close()
            if extra:
                open(os.path.join(sky.DIR, extra), 'w').close()
            with self.assertRaises(SystemExit):
                sky.leave()
            self.assertEqual(os.path.isdir(sky.DIR), kept)


if __name__ == '__main__':
    unittest.main()
